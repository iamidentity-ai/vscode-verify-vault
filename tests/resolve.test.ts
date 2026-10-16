import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../src/broker/envfile";
import { resolveEntries, type Reader } from "../src/broker/resolve";

const fake: Reader = {
  async read(ref) {
    const key = `${ref.mount}/${ref.path}#${ref.field}`;
    const table: Record<string, string> = { "secret/dev/shared/db#password": "s3cr3t-pw" };
    if (!(key in table)) throw new Error(`permission denied on ${key}`);
    return table[key];
  },
};

test("resolves references and literals, collects secret values, reports failures without throwing", async () => {
  const entries = parseEnvFile("PW=vault+kv2://secret/dev/shared/db#password\nPORT=5432\nMISSING=vault+kv2://secret/nope#x\n");
  const r = await resolveEntries(entries, fake);
  assert.deepEqual(r.env, { PW: "s3cr3t-pw", PORT: "5432" });
  assert.deepEqual(r.secretValues, ["s3cr3t-pw"]);
  assert.deepEqual(r.report.map((x) => [x.name, x.ok]), [["PW", true], ["PORT", true], ["MISSING", false]]);
  assert.match(r.report[2].error ?? "", /permission denied/);
  assert.equal(JSON.stringify(r.report).includes("s3cr3t-pw"), false, "report must never carry a value");
});
