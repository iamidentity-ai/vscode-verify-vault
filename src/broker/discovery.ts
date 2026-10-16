/** VERIFY_TENANT was documented as the bare tenant host; the OIDC issuer is <host>/oauth2. Normalize the legacy name only. */
export function issuerFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const tenant = env.VERIFY_TENANT ? env.VERIFY_TENANT.replace(/\/$/, "") : undefined;
  const issuer = env.OIDC_ISSUER ?? (tenant ? (tenant.endsWith("/oauth2") ? tenant : `${tenant}/oauth2`) : undefined);
  if (!issuer) throw new Error("Set OIDC_ISSUER (for example https://<tenant>/oauth2 for IBM Verify)");
  return issuer.replace(/\/$/, "");
}

export type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
};

/** Reads the OIDC discovery document once. Works for issuers with a path (IBM Verify) and without (Okta, Entra, Auth0, Keycloak). */
export async function fetchDiscovery(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const base = issuer.replace(/\/$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`OIDC discovery for ${base} failed: ${res.status}`);
  let d: Partial<Discovery> & { issuer?: string };
  try { d = (await res.json()) as Partial<Discovery> & { issuer?: string }; }
  catch { throw new Error(`OIDC discovery for ${base} returned a non-JSON body (is the issuer URL right? IBM Verify issuers end in /oauth2)`); }
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error(`OIDC discovery for ${base} is missing authorization_endpoint or token_endpoint`);
  if (d.issuer && d.issuer.replace(/\/$/, "") !== base) throw new Error(`OIDC discovery for ${base} reports a different issuer (${d.issuer}); use that value`);
  return { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, userinfo_endpoint: d.userinfo_endpoint, revocation_endpoint: d.revocation_endpoint };
}
