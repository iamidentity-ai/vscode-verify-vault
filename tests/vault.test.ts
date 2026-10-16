import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultClient, isExpired } from "../src/broker/vault";

test("read() re-logs in once after a 403 and retries with the fresh token", async () => {
  const subjectJwt = "x." + Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url") + ".y";
  let jwtCalls = 0;
  const getSubjectJwt = async () => { jwtCalls++; return subjectJwt; };
  const client = new VaultClient({ addr: "https://vault.example", jwtMount: "verify-dev", jwtRole: "dev", getSubjectJwt });

  const calls: { headers: Record<string, string> }[] = [];
  const responses = [
    { status: 200, body: { auth: { client_token: "t1" } } },
    { status: 403, body: { errors: ["permission denied"] } },
    { status: 200, body: { auth: { client_token: "t2" } } },
    { status: 200, body: { data: { data: { value: "v" } } } },
  ];

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push({ headers: init?.headers ?? {} });
      const r = responses.shift()!;
      return {
        ok: r.status < 400,
        status: r.status,
        text: async () => JSON.stringify(r.body),
      } as Response;
    }) as typeof fetch;

    const value = await client.read({ kind: "kv2", mount: "secret", path: "dev/shared/db", field: "value" });

    assert.equal(value, "v");
    assert.equal(calls.length, 4);
    assert.equal(calls[3].headers["x-vault-token"], "t2");
    assert.equal(jwtCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends X-Vault-Namespace only when configured", async () => {
  const subjectJwt = "x." + Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url") + ".y";
  const getSubjectJwt = async () => subjectJwt;
  const calls: { headers: Record<string, string> }[] = [];

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push({ headers: init?.headers ?? {} });
      return { ok: true, status: 200, text: async () => JSON.stringify({ auth: { client_token: "t1" } }) } as Response;
    }) as typeof fetch;

    const withNamespace = new VaultClient({ addr: "https://vault.example", jwtMount: "verify-dev", jwtRole: "dev", getSubjectJwt, namespace: "admin" });
    await withNamespace.login();
    for (const call of calls) assert.equal(call.headers["x-vault-namespace"], "admin");

    calls.length = 0;
    const withoutNamespace = new VaultClient({ addr: "https://vault.example", jwtMount: "verify-dev", jwtRole: "dev", getSubjectJwt });
    await withoutNamespace.login();
    for (const call of calls) assert.equal("x-vault-namespace" in call.headers, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isExpired reads exp from the payload", () => {
  const jwt = (p: object) => "x." + Buffer.from(JSON.stringify(p)).toString("base64url") + ".y";
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isExpired(jwt({ exp: now - 10 })), true);
  assert.equal(isExpired(jwt({ exp: now + 3600 })), false);
  assert.equal(isExpired(jwt({ sub: "u1" })), false);
  assert.equal(isExpired("not-a-jwt"), false);
});
