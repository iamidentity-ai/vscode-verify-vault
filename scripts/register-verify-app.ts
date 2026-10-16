/**
 * Registers a public PKCE OIDC app for the Vault dev broker on your own IBM Verify tenant.
 * Idempotent: re-running finds the app by name and re-applies the redirect URIs (and
 * identitySources, only when VERIFY_IDENTITY_SOURCE_IDS is set).
 *
 * Usage:
 *   VERIFY_TENANT_URL=https://<tenant>.verify.ibm.com \
 *   VERIFY_ADMIN_CLIENT_ID=<admin api client id> \
 *   VERIFY_ADMIN_SECRET=<admin api client secret> \
 *   npm run register-app
 *
 * Optional env:
 *   APP_NAME                    default "Vault dev broker"
 *   APP_URL                     default https://github.com/iamidentity-ai/vscode-verify-vault
 *   AUDIENCE                    default vault-dev-broker
 *   REDIRECT_URIS                comma-separated; default the four broker/extension callbacks
 *   VERIFY_IDENTITY_SOURCE_IDS   comma-separated identitysource ids; default = every enabled
 *                                identitysource on the tenant (see the note below)
 *   THEME_ID                    default "default"
 *   WRITE_APP_JSON               set to 1 to also write verify-app.json (gitignored; not written by default)
 *
 * Observed against a live Verify tenant 2026-09-17: creating an app with identitySources omitted, and
 * creating one with identitySources: [], both come back with identitySources: [] (Verify does not
 * default to "all enabled sources"; an app left this way blocks every sign-in). So a fresh create
 * always sends identitySources: GET /v1.0/identitysources, keep the enabled ones, use all of them
 * unless VERIFY_IDENTITY_SOURCE_IDS narrows the list (and refuse to create at all if that list is
 * empty). The GET is skipped on a re-apply against an existing app when the env var is unset, and
 * skipped everywhere once the env var is set.
 */
import { connectVerifyAdmin, extractAppId, extractClientId, listApps } from "./lib/verify-admin-client";
import { writeFileSync } from "node:fs";

const NAME = process.env.APP_NAME || "Vault dev broker";
const APP_URL = process.env.APP_URL || "https://github.com/iamidentity-ai/vscode-verify-vault";
const AUDIENCE = process.env.AUDIENCE || "vault-dev-broker";
const THEME_ID = process.env.THEME_ID || "default";
const REDIRECTS = (process.env.REDIRECT_URIS || [
  "vscode://ibm.verify-vault/callback",
  "vscode-insiders://ibm.verify-vault/callback",
  "https://vscode.dev/redirect",
  "http://127.0.0.1:41837/callback",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

function idsFromEnv(): string[] | undefined {
  const fromEnv = process.env.VERIFY_IDENTITY_SOURCE_IDS;
  return fromEnv ? fromEnv.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

/** Only called when creating a fresh app with no VERIFY_IDENTITY_SOURCE_IDS: the one path that needs the GET. */
async function enabledIdentitySourceIds(c: Awaited<ReturnType<typeof connectVerifyAdmin>>): Promise<string[]> {
  const data = await c.get("/v1.0/identitysources");
  return (data.identitySources || []).filter((s: any) => s.enabled).map((s: any) => s.id);
}

function appBody(identitySources: string[]) {
  return {
    name: NAME,
    templateId: "998",
    providers: {
      sso: { userOptions: "oidc" },
      oidc: {
        applicationUrl: APP_URL,
        properties: {
          idTokenSigningAlg: "RS256",
          accessTokenExpiry: 3600,
          refreshTokenExpiry: 86400,
          // Required companion to renewRefreshToken:"true". Omitting it makes Verify validate an unset
          // renew expiry and 400 with CSIAQ0229 ("must be between 1 and 2,147,483,647").
          renewRefreshTokenExpiry: 86400,
          // Public client: no "none" auth method exists on clientAuthMethod, but doNotGenerateClientSecret
          // plus clientAuthMethod "default" is how a working public client (no secret, PKCE-only) is expressed.
          doNotGenerateClientSecret: "true",
          generateRefreshToken: "true",
          renewRefreshToken: "true",
          consentType: "dpcm",
          idTokenEncryptAlg: "none",
          idTokenEncryptEnc: "none",
          grantTypes: {
            authorizationCode: "true", implicit: "false", deviceFlow: "false", ropc: "false",
            jwtBearer: "false", policyAuth: "false", clientCredentials: "false", tokenExchange: "false",
          },
          redirectUris: REDIRECTS,
          sendAllKnownUserAttributes: "true",
          additionalConfig: {
            responseTypes: ["none", "code"], logoutOption: "none", exchangeForSSOSessionOption: "default",
            clientAuthMethod: "default", actorTokenRequired: false,
            responseModes: ["query"], requestObjectParametersOnly: false,
            useUserDefaultEntitlements: true, dpopBoundAccessTokens: false, oidcv3: true,
            requirePushAuthorize: false, validateDPoPProofJti: false, certificateBoundAccessTokens: false,
            requestObjectSigningAlg: "RS256", authorizeRspSigningAlg: "RS256",
            authorizeRspEncryptionEnc: "none", authorizeRspEncryptionAlg: "none",
            dpopProofSigningAlg: "RS256", requestObjectMaxExpFromNbf: 1800, requestObjectRequireExp: true,
            suppressDefaultClaims: false, allowedClientAssertionVerificationKeys: [],
            requireConsentAttributeMapClaimNames: [], refreshAttributeMapClaimNames: [],
            refreshIntrospectMapClaimNames: [],
          },
        },
        scopes: [],
        entitlements: [],
        restrictEntitlements: true,
        grantProperties: { generateDeviceFlowQRCode: "false" },
        token: { accessTokenType: "jwt", audiences: [AUDIENCE] },
        consentAction: "always_prompt",
        requirePkceVerification: "true",
      },
    },
    applicationState: true,
    approvalRequired: false,
    signonState: true,
    identitySources,
    visibleOnLaunchpad: false,
    customization: { themeId: THEME_ID },
  };
}

async function main() {
  const c = await connectVerifyAdmin();
  const envIds = idsFromEnv();
  const existing = (await listApps(c, 500)).find((a) => a.name === NAME);
  let appId: string;
  if (existing) {
    appId = extractAppId(existing._links?.self?.href);
    console.log(`found existing app ${appId}; re-applying redirect URIs${envIds ? " + identity sources" : ""}`);
    await c.patchApp(appId, (app) => {
      app.providers.oidc.properties.redirectUris = REDIRECTS;
      // Only touch identitySources when the env var narrows it; otherwise leave the app's existing
      // set alone so a re-apply can never shrink identitySources out from under a working app, and
      // never fetch GET /v1.0/identitysources for a re-apply that isn't going to use the result.
      if (envIds) app.identitySources = envIds;
    });
  } else {
    // Creating fresh: only hit GET /v1.0/identitysources when nothing narrower was given.
    const sources = envIds ?? (await enabledIdentitySourceIds(c));
    if (!sources.length) {
      throw new Error("No enabled identity sources on this tenant; an app created now would allow no sign-in. Enable one or set VERIFY_IDENTITY_SOURCE_IDS.");
    }
    const created = await c.post("/v1.0/applications", appBody(sources));
    appId = extractAppId(created?._links?.self?.href);
    console.log(`created app ${appId}`);
  }

  // Birthright access: every user in the identity source(s) may sign in to this dev tool.
  const ent = await c.get(`/v1.0/owner/applications/${appId}/entitlements`);
  if (!ent.birthRightAccess) {
    await c.post(`/v1.0/owner/applications/${appId}/entitlements`, { birthRightAccess: true, requestAccess: false, additions: [], deletions: [] });
  }

  const app = await c.get(`/v1.0/applications/${appId}`);
  const o = app.providers.oidc;
  const out = {
    appId,
    clientId: extractClientId(app),
    redirectUris: o.properties.redirectUris,
    clientSecretPresent: !!o.properties.clientSecret,
    generateRefreshToken: o.properties.generateRefreshToken,
    audiences: o.token?.audiences,
    birthRightAccess: (await c.get(`/v1.0/owner/applications/${appId}/entitlements`)).birthRightAccess,
    identitySources: app.identitySources,
  };
  if (process.env.WRITE_APP_JSON === "1") {
    writeFileSync("verify-app.json", JSON.stringify(out, null, 2) + "\n");
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.clientSecretPresent) console.error("WARNING: Verify generated a client secret; the extension is a public client and will not send it. Check doNotGenerateClientSecret.");
  if (!(out.redirectUris ?? []).includes(REDIRECTS[0])) console.error(`WARNING: Verify dropped a redirect URI (${REDIRECTS[0]}).`);
  if (!(out.identitySources ?? []).length) console.error("WARNING: identitySources is empty; every sign-in to this app will be blocked. Set VERIFY_IDENTITY_SOURCE_IDS or enable an identitysource on the tenant.");
  console.log(`\nNext steps:`);
  console.log(`  VS Code settings: verifyVault.clientId = ${out.clientId}`);
  console.log(`  Standalone setup: node broker.js setup --vault-addr <vault address> --issuer <issuer> --client-id ${out.clientId}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
