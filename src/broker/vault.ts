import type { VaultRef } from "./envfile";

export type VaultConfig = { addr: string; jwtMount: string; jwtRole: string; getSubjectJwt: () => Promise<string>; namespace?: string };

/** The Verify user id inside a JWT; it is also the entity alias name Vault templates policies on. */
export function subjectOf(jwt: string): string {
  let payload: { sub?: string };
  try { payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")); }
  catch { throw new Error("VERIFY access token is not a JWT"); }
  if (!payload.sub) throw new Error("VERIFY access token has no sub claim");
  return payload.sub;
}

/** True when the JWT carries a numeric exp that has passed. No exp or an unparseable payload counts as not expired. */
export function isExpired(jwt: string): boolean {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof exp === "number" && exp * 1000 <= Date.now();
  } catch { return false; }
}

/**
 * Minimal Vault HTTP client. Authenticates by presenting the developer's IBM Verify JWT to a
 * standard `jwt` auth mount (auth/<jwtMount>/login), which yields a per-developer Vault token
 * whose policies are templated on the entity alias (the Verify `sub`).
 *
 * ponytail: developer token only. Agent identity (RFC 8693 actor token + RAR through Vault's
 * OAuth resource server, the Path Y chain) is the next plan; swap login() for the exchange there.
 */
export class VaultClient {
  private token: string | undefined;
  private readonly leases: string[] = [];

  constructor(private readonly cfg: VaultConfig) {}

  private async api(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.cfg.addr.replace(/\/$/, "")}/v1/${path}`, {
      method,
      headers: {
        ...(this.token ? { "x-vault-token": this.token } : {}),
        ...(this.cfg.namespace ? { "x-vault-namespace": this.cfg.namespace } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; }
    catch { json = { errors: [`non-JSON body (proxy or gateway error page?): ${text.slice(0, 200)}`] }; }
    if (!res.ok) throw new Error(`Vault ${method} ${path} -> ${res.status}: ${(json.errors ?? [text.slice(0, 200)]).join("; ")}`);
    return json;
  }

  async login(): Promise<void> {
    const r = await this.api("POST", `auth/${this.cfg.jwtMount}/login`, { role: this.cfg.jwtRole, jwt: await this.cfg.getSubjectJwt() });
    this.token = r.auth?.client_token;
    if (!this.token) throw new Error("Vault login returned no client_token");
  }

  // ponytail: a token revoked at Verify still logs in here until it expires. Vault's jwt auth
  // checks signature and exp only, so re-login on a 403 gets a fresh Vault token from the same
  // possibly-revoked Verify JWT; it does not re-check revocation with Verify.
  private async withRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("-> 403")) throw e;
      await this.login();
      return fn();
    }
  }

  async read(ref: VaultRef): Promise<string> {
    if (!this.token) await this.login();
    const apiPath = ref.kind === "kv2" ? `${ref.mount}/data/${ref.path}` : `${ref.mount}/${ref.path}`;
    const r = await this.withRelogin(() => this.api("GET", apiPath));
    if (ref.kind === "dyn" && r.lease_id) this.leases.push(r.lease_id);
    const data = ref.kind === "kv2" ? r.data?.data : r.data;
    const v = data?.[ref.field];
    if (v === undefined || v === null) throw new Error(`${ref.mount}/${ref.path} has no field '${ref.field}'`);
    return String(v);
  }

  /** Writes secret/dev/users/<sub>/<name> and returns the reference to put in .env.vault. */
  async putUserSecret(name: string, value: string): Promise<string> {
    if (!this.token) await this.login();
    const path = `dev/users/${subjectOf(await this.cfg.getSubjectJwt())}/${name}`;
    await this.withRelogin(() => this.api("POST", `secret/data/${path}`, { data: { value } }));
    return `vault+kv2://secret/${path}#value`;
  }

  /** Revokes every dynamic lease this client created. Best effort; TTL is the backstop. */
  async revokeLeases(): Promise<void> {
    for (const id of this.leases.splice(0)) {
      await this.api("PUT", "sys/leases/revoke", { lease_id: id }).catch(() => undefined);
    }
  }
}
