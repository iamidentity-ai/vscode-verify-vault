import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizeUrl, challengeFor, newVerifier } from "../src/auth/pkce";

test("S256 challenge matches the RFC 7636 appendix B vector", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("verifier is 43 unreserved characters and unique", () => {
  const a = newVerifier(), b = newVerifier();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test("authorize URL carries every required parameter and nothing secret", () => {
  const url = new URL(buildAuthorizeUrl({
    authorizeEndpoint: "https://idp.example/oauth2/authorize", clientId: "cid", redirectUri: "vscode://ibm.verify-vault/callback",
    scopes: ["openid", "email"], state: "st", challenge: "ch",
  }));
  assert.equal(url.origin + url.pathname, "https://idp.example/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "vscode://ibm.verify-vault/callback");
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("client_secret"), false);
});
