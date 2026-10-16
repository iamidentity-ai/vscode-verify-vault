import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/broker/run";

test("timeout kills the whole process group, not just the shell", async () => {
  const t0 = Date.now();
  const r = await runCommand("sleep 4 | cat", {}, process.cwd(), 500);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("child never inherits the broker's own secrets", async () => {
  process.env.VERIFY_ACCESS_TOKEN = "x.eyJ.y";
  process.env.VAULT_TOKEN = "hvs.test";
  const r = await runCommand("env", {}, process.cwd(), 5000);
  assert.equal(r.output.includes("VERIFY_ACCESS_TOKEN"), false);
  assert.equal(r.output.includes("VAULT_TOKEN"), false);
});

test("child env is an allowlist, not the developer's whole shell environment", async () => {
  process.env.GITHUB_TOKEN = "ghp_test";
  process.env.AWS_SECRET_ACCESS_KEY = "aws_test";
  const r = await runCommand("env", {}, process.cwd(), 5000);
  assert.equal(r.output.includes("GITHUB_TOKEN"), false);
  assert.equal(r.output.includes("AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(r.output.includes("PATH="), true);
});
