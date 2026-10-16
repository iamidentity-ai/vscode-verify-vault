import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { buildAuthorizeUrl, challengeFor, newVerifier } from "../auth/pkce";
import { keychainDelete, keychainGet, keychainSet } from "./keychain";
import { fetchDiscovery, type Discovery } from "./discovery";

export type TokenStore = { get(account: string): Promise<string | undefined>; set(account: string, value: string): Promise<void>; del(account: string): Promise<void> };
export type LoginToken = "access" | "id";
export type AuthConfig = {
  issuer: string; clientId: string; port: number; redirectHost: string; scopes: string[];
  /** Which token is presented to Vault: "access" (IBM Verify JWT access tokens) or "id" (Okta, Entra, Auth0, Keycloak). */
  loginToken: LoginToken;
  fetchImpl?: typeof fetch; openBrowser?: (url: string) => void; store?: TokenStore; discovery?: Discovery;
};
type Tok = { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number };

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * Token supply for the standalone broker (no VS Code). currentLoginToken()/currentAccessToken() never open a
 * browser: they return the cached token or refresh silently from the stored refresh token. signInInteractive()
 * runs OIDC code + PKCE with a loopback callback; concurrent calls share one flow. Endpoints come from the
 * provider's OIDC discovery document, fetched once per process (or injected for tests).
 */
export class TokenSource {
  private access?: { token: string; idToken?: string; expiresAt: number };
  private signIn?: Promise<string>;
  private refreshing?: Promise<string | undefined>;
  private disc?: Promise<Discovery>;
  authorizeUrl?: string;
  lastError?: string;

  constructor(private readonly cfg: AuthConfig) {}

  private get f(): typeof fetch { return this.cfg.fetchImpl ?? fetch; }
  private get store(): TokenStore { return this.cfg.store ?? { get: keychainGet, set: keychainSet, del: keychainDelete }; }
  private get account(): string { return `${this.cfg.issuer.replace(/\/$/, "")}|${this.cfg.clientId}`; }
  /** v0.2.x stored the refresh token under the bare tenant host (issuer without /oauth2). Read it once and migrate. */
  private get legacyAccount(): string { return `${this.cfg.issuer.replace(/\/$/, "").replace(/\/oauth2$/, "")}|${this.cfg.clientId}`; }
  private get redirectUri(): string { return `http://${this.cfg.redirectHost}:${this.cfg.port}/callback`; }

  /** Every token currently held (access and id), for the caller's redaction set. */
  held(): string[] { return [this.access?.token, this.access?.idToken].filter((t): t is string => !!t); }

  /** Discovery document, fetched once per process (or injected). */
  discovery(): Promise<Discovery> {
    if (!this.disc) {
      this.disc = this.cfg.discovery
        ? Promise.resolve(this.cfg.discovery)
        : fetchDiscovery(this.cfg.issuer, this.f).catch((e) => { this.disc = undefined; throw e; });
    }
    return this.disc;
  }

  /** The token Vault should see (access or id per config), cached or silently refreshed. Never interactive. */
  async currentLoginToken(): Promise<string | undefined> {
    const a = await this.currentAccessToken();
    if (!a) return undefined;
    if (this.cfg.loginToken === "access") return a;
    return this.access?.idToken;   // undefined if the provider returned no id_token: the caller reports "sign in again"
  }

  /** The access token, for userinfo. Cached or silently refreshed. Never interactive. */
  async currentAccessToken(): Promise<string | undefined> {
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token;
    // Parallel tool calls must share one refresh: a rotated refresh token spent twice would be invalid the second time.
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async signOut(): Promise<void> {
    const rt = await this.store.get(this.account);
    if (rt) {
      const disc = await this.discovery().catch((e) => { this.lastError = (e as Error).message; return undefined; });
      if (!disc?.revocation_endpoint) {
        if (disc) this.lastError = "provider has no revocation_endpoint";
      } else {
        try {
          const res = await this.f(disc.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: this.cfg.clientId, token: rt, token_type_hint: "refresh_token" }),
            signal: AbortSignal.timeout(12_000),
          });
          if (!res.ok) this.lastError = `revoke ${res.status}`;
        } catch (e) {
          // A network failure here must not surface the refresh token; the message is from fetch/AbortSignal, not the body.
          this.lastError = (e as Error).message;
        }
      }
    }
    // An in-flight refresh or sign-in must not re-store a token after we delete it below.
    await this.refreshing;
    await this.signIn?.catch(() => undefined);
    await this.store.del(this.account);
    this.access = undefined;
  }

  private async refresh(): Promise<string | undefined> {
    let rt = await this.store.get(this.account);
    if (!rt && this.legacyAccount !== this.account) {
      const legacy = await this.store.get(this.legacyAccount);
      if (legacy) {
        await this.store.set(this.account, legacy);
        await this.store.del(this.legacyAccount);
        rt = legacy;
      }
    }
    if (!rt) return undefined;
    try {
      return await this.accept(await this.token({ grant_type: "refresh_token", refresh_token: rt }));
    } catch (e) {
      this.lastError = (e as Error).message;
      // Only a rejected grant means the stored token is dead; a network blip or a 502 page must not force a new sign-in.
      if (this.lastError.includes("invalid_grant")) await this.store.del(this.account);
      return undefined;
    }
  }

  signInInteractive(): Promise<string> {
    if (!this.signIn) {
      this.signIn = this.runPkce().finally(() => { this.signIn = undefined; this.authorizeUrl = undefined; });
      this.signIn.catch((e) => { this.lastError = (e as Error).message; });
    }
    return this.signIn;
  }

  private async runPkce(): Promise<string> {
    const disc = await this.discovery();
    const state = randomUUID();
    const verifier = newVerifier();
    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", `http://${this.cfg.redirectHost}`);
        if (u.pathname !== "/callback") { res.statusCode = 404; res.end(); return; }
        // DNS rebinding defence per RFC 8252 section 8.3 and the MCP Inspector CVE-2025-49596 lesson.
        const allowedHosts = [`${this.cfg.redirectHost}:${this.cfg.port}`, `127.0.0.1:${this.cfg.port}`, `localhost:${this.cfg.port}`];
        if (!req.headers.host || !allowedHosts.includes(req.headers.host)) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("wrong host");
          return;
        }
        // State first. A request without the right state is not from this flow: answer 400 and keep listening,
        // so a stray local request or a hostile tab can neither cancel the sign-in nor plant text in lastError.
        if (u.searchParams.get("state") !== state) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Not this sign-in (state mismatch). Return to your editor and try again.");
          return;
        }
        const err = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("connection", "close");
        // Fixed bodies only: nothing from the query is reflected into HTML.
        res.end(!err && code ? "<h2>Signed in. You can close this tab.</h2>" : "<h2>Sign-in failed. Return to your editor for details.</h2>");
        clearTimeout(timer);
        server.close();
        if (!err && code) resolve(code);
        else reject(new Error(`sign-in failed: ${err ?? "no code"}${err ? " " + (u.searchParams.get("error_description") ?? "") : ""}`.trim()));
      });
      const timer = setTimeout(() => { server.close(); server.closeAllConnections(); reject(new Error("sign-in timed out after 5 minutes")); }, SIGN_IN_TIMEOUT_MS);
      server.once("error", (e) => { clearTimeout(timer); reject(new Error(`cannot listen on 127.0.0.1:${this.cfg.port}: ${e.message}`)); });
      server.listen(this.cfg.port, "127.0.0.1", () => {
        const url = buildAuthorizeUrl({ authorizeEndpoint: disc.authorization_endpoint, clientId: this.cfg.clientId, redirectUri: this.redirectUri, scopes: this.cfg.scopes, state, challenge: challengeFor(verifier) });
        this.authorizeUrl = url;
        try { (this.cfg.openBrowser ?? openBrowser)(url); } catch (e) { clearTimeout(timer); server.close(); server.closeAllConnections(); reject(e as Error); }
      });
    });
    return this.accept(await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, code_verifier: verifier }));
  }

  private async token(form: Record<string, string>): Promise<Tok> {
    const disc = await this.discovery();
    const res = await this.f(disc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, ...form }),   // public client: PKCE is the binding
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.json()) as Tok & { error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`token endpoint ${res.status}: ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
    return body;
  }

  private async accept(t: Tok): Promise<string> {
    if (t.refresh_token) {
      try { await this.store.set(this.account, t.refresh_token); }
      catch { throw new Error("could not store the refresh token (keychain); you will need to sign in again next start"); }
    }
    // only after the store succeeded, so a rejected sign-in leaves currentLoginToken() empty
    // expiresAt is keyed on the access token's expires_in even in "id" mode; a provider whose id_token
    // outlives (or falls short of) its access token would need the id token's own exp tracked separately.
    this.access = { token: t.access_token, idToken: t.id_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    this.lastError = undefined;
    return t.access_token;
  }
}

export function openBrowser(url: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => undefined);
}
