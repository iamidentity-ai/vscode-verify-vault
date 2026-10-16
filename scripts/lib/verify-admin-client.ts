/**
 * Minimal IBM Verify admin-API client: mints a client_credentials token and wraps
 * get/post/put/del plus a patchApp helper that strips read-only fields before a PUT.
 *
 * Env vars (all required; bring your own tenant, no default is baked in):
 *   VERIFY_TENANT_URL       your Verify tenant, for example https://<tenant>.verify.ibm.com
 *   VERIFY_ADMIN_CLIENT_ID  an admin API client id on that tenant (client_credentials grant)
 *   VERIFY_ADMIN_SECRET     that client's secret
 */

// Fields that come back on GET but are read-only / server-managed. Leaving
// any of these in a PUT body gives an empty-body 400 with no messageId
// (CSIAD0023 for icons) — see the IBM Verify admin API notes.
const READ_ONLY_APP_FIELDS = ["icon", "defaultIcon", "customIcon", "_links", "meta", "id"];

export interface VerifyAdminClient {
  tenant: string;
  token: string;
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  put(path: string, body: unknown): Promise<any>;
  del(path: string): Promise<any>;
  /** GET an app, mutate it in place via `mutate`, strip read-only fields, PUT it back. */
  patchApp(appId: string, mutate: (app: any) => void): Promise<any>;
}

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return j.error_description || j.messageDescription || j.error || j.messageId || text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

export async function connectVerifyAdmin(opts: { tenant?: string; clientId?: string; secret?: string } = {}): Promise<VerifyAdminClient> {
  const tenant = opts.tenant || process.env.VERIFY_TENANT_URL;
  const clientId = opts.clientId || process.env.VERIFY_ADMIN_CLIENT_ID;
  const secret = opts.secret || process.env.VERIFY_ADMIN_SECRET;
  if (!tenant) throw new Error("VERIFY_TENANT_URL is required (export it or pass { tenant } to connectVerifyAdmin)");
  if (!clientId) throw new Error("VERIFY_ADMIN_CLIENT_ID is required (export it or pass { clientId } to connectVerifyAdmin)");
  if (!secret) throw new Error("VERIFY_ADMIN_SECRET is required (export it or pass { secret } to connectVerifyAdmin)");

  const tokenRes = await fetch(`${tenant}/v1.0/endpoint/default/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Admin token mint failed: ${tokenRes.status} ${await parseErrorBody(tokenRes)}`);
  }
  const { access_token } = await tokenRes.json();
  if (!access_token) {
    throw new Error("Admin token mint returned no access_token");
  }

  const authHeaders = (withJson: boolean) => ({
    Authorization: `Bearer ${access_token}`,
    Accept: "application/json",
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  });

  const client: VerifyAdminClient = {
    tenant,
    token: access_token,

    async get(path: string) {
      const res = await fetch(`${tenant}${path}`, { headers: authHeaders(false) });
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await parseErrorBody(res)}`);
      return res.json();
    },

    async post(path: string, body: unknown) {
      const res = await fetch(`${tenant}${path}`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await parseErrorBody(res)}`);
      // 201s with no body are common (app create) — callers use Location/_links instead
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    },

    async put(path: string, body: unknown) {
      const res = await fetch(`${tenant}${path}`, {
        method: "PUT",
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PUT ${path} -> ${res.status} ${await parseErrorBody(res)}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    },

    async del(path: string) {
      const res = await fetch(`${tenant}${path}`, { method: "DELETE", headers: authHeaders(false) });
      if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status} ${await parseErrorBody(res)}`);
      return {};
    },

    async patchApp(appId: string, mutate: (app: any) => void) {
      const app = await client.get(`/v1.0/applications/${appId}`);
      mutate(app);
      for (const field of READ_ONLY_APP_FIELDS) delete app[field];
      return client.put(`/v1.0/applications/${appId}`, app);
    },
  };

  return client;
}

/** GET /v1.0/applications and return the array from the correct (non-obvious) key. */
export async function listApps(client: VerifyAdminClient, limit = 200): Promise<any[]> {
  const data = await client.get(`/v1.0/applications?limit=${limit}`);
  // _embedded.applications is correct; .applications/.resources silently yield []
  // (burned 2026-07-12 — see the IBM Verify admin API notes).
  return data._embedded?.applications || [];
}

/** Extract clientId from a full app resource (varies by app type/provider shape). */
export function extractClientId(app: any): string {
  return app.clientId || app.providers?.oidc?.clientId || app.providers?.oidc?.properties?.clientId || "";
}

/** Extract the numeric app id from a create response's _links.self.href or Location header. */
export function extractAppId(linksHref: string | undefined): string {
  const m = (linksHref || "").match(/\/applications\/(\d+)/);
  if (!m) throw new Error(`Could not extract app id from href: ${linksHref}`);
  return m[1];
}
