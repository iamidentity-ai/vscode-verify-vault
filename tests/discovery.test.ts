import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDiscovery, issuerFromEnv } from "../src/broker/discovery";

const doc = { authorization_endpoint: "https://idp.example/oauth2/v1/authorize", token_endpoint: "https://idp.example/oauth2/v1/token", userinfo_endpoint: "https://idp.example/oauth2/v1/userinfo", revocation_endpoint: "https://idp.example/oauth2/v1/revoke" };

test("fetches <issuer>/.well-known/openid-configuration and returns the four endpoints", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => doc }; }) as unknown as typeof fetch;
  const d = await fetchDiscovery("https://idp.example/", f);
  assert.deepEqual(urls, ["https://idp.example/.well-known/openid-configuration"]);
  assert.equal(d.authorization_endpoint, doc.authorization_endpoint);
  assert.equal(d.revocation_endpoint, doc.revocation_endpoint);
});

test("issuer with a path keeps the path (IBM Verify)", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => doc }; }) as unknown as typeof fetch;
  await fetchDiscovery("https://idp.example/oauth2", f);
  assert.deepEqual(urls, ["https://idp.example/oauth2/.well-known/openid-configuration"]);
});

test("a non-JSON body (bare tenant host) and an issuer mismatch are clear errors", async () => {
  const html = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } })) as unknown as typeof fetch;
  await assert.rejects(fetchDiscovery("https://idp.example", html), /non-JSON body.*\/oauth2/);
  const other = (async () => ({ ok: true, status: 200, json: async () => ({ ...doc, issuer: "https://elsewhere.example" }) })) as unknown as typeof fetch;
  await assert.rejects(fetchDiscovery("https://idp.example", other), /different issuer/);
});

test("a non-2xx or a document without the two required endpoints is an error naming the issuer", async () => {
  const bad = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(fetchDiscovery("https://idp.example", bad), /discovery.*idp\.example.*404/);
  const partial = (async () => ({ ok: true, status: 200, json: async () => ({ token_endpoint: "x" }) })) as unknown as typeof fetch;
  await assert.rejects(fetchDiscovery("https://idp.example", partial), /authorization_endpoint/);
});

test("issuerFromEnv: OIDC_ISSUER wins, bare/normalized VERIFY_TENANT", () => {
  assert.equal(issuerFromEnv({ OIDC_ISSUER: "https://idp.example/", VERIFY_TENANT: "https://tenant.example" }), "https://idp.example");
  assert.equal(issuerFromEnv({ VERIFY_TENANT: "https://tenant.example" }), "https://tenant.example/oauth2");
  assert.equal(issuerFromEnv({ VERIFY_TENANT: "https://tenant.example/oauth2/" }), "https://tenant.example/oauth2");
});

test("issuerFromEnv: neither OIDC_ISSUER nor VERIFY_TENANT set throws", () => {
  assert.throws(() => issuerFromEnv({}), /Set OIDC_ISSUER/);
});
