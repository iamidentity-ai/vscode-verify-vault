import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactedTail } from "../src/broker/redact";

test("every occurrence of every secret is replaced, longest first", () => {
  const out = redact("pw=abc123def token=abc123 again abc123def", ["abc123", "abc123def"]);
  assert.equal(out, "pw=[redacted] token=[redacted] again [redacted]");
});

test("values shorter than 4 chars are not redacted (would destroy the output)", () => {
  assert.equal(redact("port 80 ok", ["80"]), "port 80 ok");
  assert.equal(redact("eA== ok", ["x"]), "eA== ok");   // the 4-char base64 of a 1-char secret must not be redacted
});

test("no secrets means untouched output", () => {
  assert.equal(redact("hello", []), "hello");
});

test("redactedTail redacts before truncating so a straddling secret cannot leak its tail", () => {
  const secret = "SECRETVALUE1234";
  const out = redactedTail("a".repeat(100) + secret + "b".repeat(7990), [secret], 8000);
  assert.equal(out.includes("VALUE1234"), false);
  assert.equal(out.startsWith("...\n"), true);
});

test("URL-encoded, base64 and JSON-escaped forms of a secret are redacted too", () => {
  const secret = 'p@ss "w/rd"';
  const forms = [encodeURIComponent(secret), Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1)];
  const out = redact(forms.join(" | "), [secret]);
  assert.equal(out, "[redacted] | [redacted] | [redacted]");
});
