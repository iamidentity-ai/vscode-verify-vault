import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, parseRef, starterEnvFile } from "../src/broker/envfile";

test("kv2 reference with field", () => {
  assert.deepEqual(parseRef("vault+kv2://secret/dev/shared/db#password"), { kind: "kv2", mount: "secret", path: "dev/shared/db", field: "password" });
});

test("field defaults to value; kv1 and dyn parse", () => {
  assert.equal(parseRef("vault+kv1://legacy/app").field, "value");
  assert.equal(parseRef("vault+dyn://database/creds/readonly#username").kind, "dyn");
});

test("literal: prefix forces a literal, anything else is a literal", () => {
  assert.deepEqual(parseRef("literal:vault+kv2://x/y"), { kind: "literal", value: "vault+kv2://x/y" });
  assert.deepEqual(parseRef("plain"), { kind: "literal", value: "plain" });
});

test("malformed vault+ references are rejected, not kept as literals", () => {
  assert.throws(() => parseRef("vault+kv://secret/x"), /malformed/);
  assert.throws(() => parseRef("vault+kv2://secret"), /malformed/);
});

test("a malformed reference in an env file does not leak the raw value into the error", () => {
  assert.throws(
    () => parseEnvFile("TOKEN=vault+kv://s3cr3t"),
    (err: unknown) => err instanceof Error && /malformed/.test(err.message) && !err.message.includes("s3cr3t"),
  );
});

test("env file: comments, blanks, quotes, names", () => {
  const entries = parseEnvFile(`# comment\n\nDB_PASSWORD="vault+kv2://secret/dev/shared/db#password"\nPORT=5432\n`);
  assert.deepEqual(entries.map((e) => e.name), ["DB_PASSWORD", "PORT"]);
  assert.equal(entries[0].ref.kind, "kv2");
  assert.deepEqual(entries[1].ref, { kind: "literal", value: "5432" });
  assert.throws(() => parseEnvFile("1BAD=x"), /bad variable name/);
  assert.throws(() => parseEnvFile("NOEQUALS"), /NAME=value/);
});

test("the starter .env.vault parses to the two demo entries", () => {
  const entries = parseEnvFile(starterEnvFile());
  assert.deepEqual(entries.map((e) => e.name), ["DEMO_SECRET", "PORT"]);
  assert.equal(entries[0].ref.kind, "kv2");
});
