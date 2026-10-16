import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { TokenSource } from "../src/broker/auth";

/** node's fetch will not let a caller override the Host header, so a forged Host needs a raw http.request. */
function getWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

const PORT = 41999;
const DISC = { authorization_endpoint: "https://t.example/oauth2/authorize", token_endpoint: "https://t.example/oauth2/token", userinfo_endpoint: "https://t.example/oauth2/userinfo", revocation_endpoint: "https://t.example/oauth2/revoke" };
function fakeStore() {
  const m = new Map<string, string>();
  return { get: async (a: string) => m.get(a), set: async (a: string, v: string) => { m.set(a, v); }, del: async (a: string) => { m.delete(a); }, map: m };
}
/** A fake fetch for the token and revoke endpoints: records every call's URL and form, plus grant types. */
function fakeFetch(expiresIn: number) {
  const grants: string[] = [];
  const calls: { url: string; form: URLSearchParams }[] = [];
  let n = 0;
  const f = (async (url: string, init: any) => {
    const form = new URLSearchParams(init.body as string);
    calls.push({ url, form });
    assert.equal(form.get("client_id"), "cid");
    if (form.has("grant_type")) {
      grants.push(form.get("grant_type")!);
      assert.equal(form.has("client_secret"), false);
    }
    n += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: `at${n}`, id_token: `id${n}`, refresh_token: `rt${n}`, expires_in: expiresIn }) };
  }) as unknown as typeof fetch;
  return { f, grants, calls };
}
/** The last callback request fired by fakeBrowser, watched: resolves once the page body is asserted, never swallowed. */
let lastCallback: Promise<void> | undefined;
/** A fake browser: parses state from the authorize URL and hits the loopback callback like a real redirect. */
const fakeBrowser = (url: string) => {
  const u = new URL(url);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const cb = `${u.searchParams.get("redirect_uri")}?code=abc&state=${u.searchParams.get("state")}`;
  lastCallback = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      fetch(cb.replace("vault-dev.localhost", "127.0.0.1"))
        .then(async (r) => {
          const body = await r.text();
          if (body.includes("Signed in")) resolve();
          else reject(new Error(`callback page missing "Signed in": ${body}`));
        })
        .catch(reject);
    }, 20);
  });
};

test("interactive sign-in completes through the loopback callback and stores the refresh token", async () => {
  const store = fakeStore();
  const { f, grants } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: fakeBrowser, store });
  assert.equal(await ts.currentLoginToken(), undefined);
  const at = await ts.signInInteractive();
  await lastCallback;
  assert.equal(at, "at1");
  assert.deepEqual(grants, ["authorization_code"]);
  assert.equal([...store.map.values()][0], "rt1");
  assert.equal(await ts.currentLoginToken(), "at1", "cached, no second grant");
  assert.deepEqual(grants, ["authorization_code"]);
});

test("currentLoginToken() refreshes silently from the stored refresh token when the access token is stale", async () => {
  const store = fakeStore();
  await store.set("https://t.example|cid", "rt-old");
  const { f, grants } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: () => assert.fail("must not open a browser"), store });
  assert.equal(await ts.currentLoginToken(), "at1");
  assert.deepEqual(grants, ["refresh_token"]);
});

test("concurrent currentLoginToken() calls share one refresh", async () => {
  const store = fakeStore();
  await store.set("https://t.example|cid", "rt-old");
  const { f, grants } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: () => assert.fail("must not open a browser"), store });
  const [a, b, c] = await Promise.all([ts.currentLoginToken(), ts.currentLoginToken(), ts.currentLoginToken()]);
  assert.equal(a, "at1");
  assert.equal(b, "at1");
  assert.equal(c, "at1");
  assert.deepEqual(grants, ["refresh_token"]);
});

test("a failed refresh clears the stored token and currentLoginToken() returns undefined", async () => {
  const store = fakeStore();
  await store.set("https://t.example|cid", "rt-bad");
  const f = (async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })) as unknown as typeof fetch;
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: () => assert.fail("must not open a browser"), store });
  assert.equal(await ts.currentLoginToken(), undefined);
  assert.equal(store.map.size, 0);
});

test("a failing keychain never leaks the refresh token into lastError", async () => {
  const store = fakeStore();
  store.set = async (_a: string, v: string) => { throw new Error(`Command failed: /usr/bin/security add-generic-password -w ${v}`); };
  const { f } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: fakeBrowser, store });
  await assert.rejects(ts.signInInteractive(), /could not store the refresh token/);
  assert.equal((ts.lastError ?? "").includes("rt1"), false);
});

test("signOut revokes the refresh token at Verify and clears the store", async () => {
  const store = fakeStore();
  const { f, calls } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: fakeBrowser, store });
  await ts.signInInteractive();
  await lastCallback;

  await ts.signOut();

  const revoke = calls.find((c) => c.url.endsWith("/oauth2/revoke"));
  assert.ok(revoke, "no revoke request was sent");
  assert.equal(revoke!.form.get("token_type_hint"), "refresh_token");
  assert.equal(revoke!.form.get("token"), "rt1");
  assert.equal(store.map.size, 0);

  let networked = false;
  const noNetwork = (async () => { networked = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
  const ts2 = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: noNetwork, store });
  assert.equal(await ts2.currentLoginToken(), undefined);
  assert.equal(networked, false);
});

test("signOut with no revocation_endpoint still deletes locally and makes no revoke request", async () => {
  const store = fakeStore();
  const { f, calls } = fakeFetch(3600);
  const noRevoke = { authorization_endpoint: DISC.authorization_endpoint, token_endpoint: DISC.token_endpoint };
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: noRevoke, fetchImpl: f, openBrowser: fakeBrowser, store });
  await ts.signInInteractive();
  await lastCallback;
  const callCountBefore = calls.length;

  await ts.signOut();

  assert.equal(calls.length, callCountBefore, "no revoke request was sent");
  assert.equal(store.map.size, 0);
  assert.match(ts.lastError ?? "", /revocation_endpoint/);
});

test("a bad-state request is refused with 400 and the flow survives to complete", async () => {
  const store = fakeStore();
  const { f, grants } = fakeFetch(3600);
  const badThenGoodBrowser = (url: string) => {
    const u = new URL(url);
    setTimeout(async () => {
      const bad = await fetch(`http://127.0.0.1:${PORT}/callback?code=abc&state=wrong`);
      assert.equal(bad.status, 400);
      const cb = `${u.searchParams.get("redirect_uri")}?code=abc&state=${u.searchParams.get("state")}`;
      await fetch(cb.replace("vault-dev.localhost", "127.0.0.1")).catch(() => undefined);
    }, 20);
  };
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: badThenGoodBrowser, store });
  const at = await ts.signInInteractive();
  assert.equal(at, "at1");
  assert.deepEqual(grants, ["authorization_code"]);
});

test("callback with a wrong Host header is refused and the flow continues", async () => {
  const store = fakeStore();
  const { f, grants } = fakeFetch(3600);
  const badHostThenGoodBrowser = (url: string) => {
    const u = new URL(url);
    setTimeout(async () => {
      const bad = await getWithHost(PORT, `/callback?code=abc&state=${u.searchParams.get("state")}`, "evil.example:41999");
      assert.equal(bad, 400);
      const cb = `${u.searchParams.get("redirect_uri")}?code=abc&state=${u.searchParams.get("state")}`;
      await fetch(cb.replace("vault-dev.localhost", "127.0.0.1")).catch(() => undefined);
    }, 20);
  };
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: badHostThenGoodBrowser, store });
  const at = await ts.signInInteractive();
  assert.equal(at, "at1");
  assert.deepEqual(grants, ["authorization_code"]);
});

test("loginToken id presents the id_token to Vault and the access token to userinfo", async () => {
  const store = fakeStore();
  const { f } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "127.0.0.1", scopes: ["openid"], loginToken: "id", discovery: DISC, fetchImpl: f, openBrowser: fakeBrowser, store });
  await ts.signInInteractive();
  assert.equal(await ts.currentLoginToken(), "id1");
  assert.equal(await ts.currentAccessToken(), "at1");
});

test("discovery is fetched once and its endpoints are used", async () => {
  const store = fakeStore();
  await store.set("https://t.example|cid", "rt-old");
  const urls: string[] = [];
  const f = (async (url: string, init?: any) => {
    urls.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) return { ok: true, status: 200, json: async () => DISC };
    return { ok: true, status: 200, json: async () => ({ access_token: "at1", id_token: "id1", refresh_token: "rt1", expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  const ts = new TokenSource({ issuer: "https://t.example", clientId: "cid", port: PORT, redirectHost: "127.0.0.1", scopes: ["openid"], loginToken: "access", fetchImpl: f, openBrowser: () => assert.fail("no browser"), store });
  assert.equal(await ts.currentLoginToken(), "at1");
  assert.equal(await ts.currentLoginToken(), "at1");
  assert.deepEqual(urls, ["https://t.example/.well-known/openid-configuration", "https://t.example/oauth2/token"]);
});

test("a legacy refresh token stored under the bare tenant host is migrated to the issuer-qualified key", async () => {
  const store = fakeStore();
  await store.set("https://t.example|cid", "rt-old");
  const { f, grants } = fakeFetch(3600);
  const ts = new TokenSource({ issuer: "https://t.example/oauth2", clientId: "cid", port: PORT, redirectHost: "vault-dev.localhost", scopes: ["openid"], loginToken: "access", discovery: DISC, fetchImpl: f, openBrowser: () => assert.fail("must not open a browser"), store });
  assert.equal(await ts.currentLoginToken(), "at1");
  assert.deepEqual(grants, ["refresh_token"]);
  assert.equal(store.map.has("https://t.example/oauth2|cid"), true);
  assert.equal(store.map.has("https://t.example|cid"), false);
});
