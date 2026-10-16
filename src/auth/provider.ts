import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl, challengeFor, newVerifier } from "./pkce";
import { URI_AUTHORITY } from "../constants";

const SESSION_KEY = "ibm-verify.session";
const REFRESH_KEY = "ibm-verify.refresh";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };
type StoredSession = vscode.AuthenticationSession & { expiresAt: number };
type Pending = { verifier: string; resolve: (u: vscode.Uri) => void; reject: (e: Error) => void };

/** OIDC authorization code + PKCE against an IBM Verify tenant, public client, callback via the VS Code URI handler. */
export class VerifyAuthProvider implements vscode.AuthenticationProvider, vscode.UriHandler {
  private readonly emitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.emitter.event;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private cfg<T>(key: string, dflt: T): T { return vscode.workspace.getConfiguration("verifyVault").get<T>(key, dflt); }
  private get tenant(): string {
    const t = this.cfg<string>("tenant", "");
    if (!t) throw new Error("Set verifyVault.tenant");
    return t.replace(/\/$/, "");
  }
  private get clientId(): string {
    const id = this.cfg<string>("clientId", "");
    if (!id) throw new Error("Set verifyVault.clientId");
    return id;
  }
  private get redirectUri(): string { return `${vscode.env.uriScheme}://${URI_AUTHORITY}/callback`; }

  // vscode.UriHandler: the browser lands on vscode://ibm.verify-vault/callback?code=..&state=..
  handleUri(uri: vscode.Uri): void {
    const q = new URLSearchParams(uri.query);
    const state = q.get("state") ?? "";
    const p = this.pending.get(state);
    if (!p) return;
    this.pending.delete(state);
    const err = q.get("error");
    if (err) p.reject(new Error(`${err}: ${q.get("error_description") ?? ""}`));
    else p.resolve(uri);
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const s = await this.stored();
    if (!s) return [];
    if (Date.now() < s.expiresAt - 60_000) return [s];
    try { return [await this.refresh(s)]; }
    catch (e) {
      // Only a rejected grant means the stored token is dead; a network blip or a 502 must not sign the user out.
      if (/invalid_grant|no refresh token/.test(String((e as Error).message))) await this.clear(s);
      return [];
    }
  }

  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const state = randomUUID();
    const verifier = newVerifier();
    const url = buildAuthorizeUrl({ authorizeEndpoint: `${this.tenant}/oauth2/authorize`, clientId: this.clientId, redirectUri: this.redirectUri, scopes, state, challenge: challengeFor(verifier) });
    const callback = new Promise<vscode.Uri>((resolve, reject) => {
      this.pending.set(state, { verifier, resolve, reject });
      setTimeout(() => { if (this.pending.delete(state)) reject(new Error("IBM Verify sign-in timed out after 5 minutes")); }, SIGN_IN_TIMEOUT_MS);
    });
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const uri = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Finish signing in to IBM Verify in your browser" },
      () => callback,
    );
    const code = new URLSearchParams(uri.query).get("code");
    if (!code) throw new Error("IBM Verify callback carried no authorization code");
    const tok = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, code_verifier: verifier });
    const session = await this.store(tok, scopes, undefined);
    this.emitter.fire({ added: [session], removed: [], changed: [] });
    return session;
  }

  async removeSession(): Promise<void> {
    await this.clear(await this.stored());
  }

  private async refresh(prev: StoredSession): Promise<vscode.AuthenticationSession> {
    const rt = await this.ctx.secrets.get(REFRESH_KEY);
    if (!rt) throw new Error("no refresh token");
    const tok = await this.token({ grant_type: "refresh_token", refresh_token: rt });
    const session = await this.store(tok, prev.scopes, prev.id);
    this.emitter.fire({ added: [], removed: [], changed: [session] });
    return session;
  }

  private async token(form: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(`${this.tenant}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, ...form }),   // public client: no client_secret, PKCE is the binding
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`IBM Verify token endpoint ${res.status}: ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
    return body;
  }

  private async store(tok: TokenResponse, scopes: readonly string[], keepId: string | undefined): Promise<StoredSession> {
    const me = (await fetch(`${this.tenant}/oauth2/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(12_000) }).then((r) => r.json())) as
      { sub: string; email?: string; preferred_username?: string; name?: string };
    const session: StoredSession = {
      id: keepId ?? randomUUID(),                 // id is stable across refresh so VS Code sees "changed", not "removed"
      accessToken: tok.access_token,
      scopes: [...scopes],
      account: { id: me.sub, label: me.email ?? me.preferred_username ?? me.name ?? me.sub },
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    };
    await this.ctx.secrets.store(SESSION_KEY, JSON.stringify(session));   // OS keychain via SecretStorage
    if (tok.refresh_token) await this.ctx.secrets.store(REFRESH_KEY, tok.refresh_token);
    return session;
  }

  private async stored(): Promise<StoredSession | undefined> {
    const raw = await this.ctx.secrets.get(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : undefined;
  }

  private async clear(s: StoredSession | undefined): Promise<void> {
    await this.ctx.secrets.delete(SESSION_KEY);
    await this.ctx.secrets.delete(REFRESH_KEY);
    if (s) this.emitter.fire({ added: [], removed: [s], changed: [] });
  }
}
