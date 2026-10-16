import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeServerEntry, parseArgs, detectClients, runCli } from "../src/broker/cli";

const entry = { command: "node", args: ["/abs/broker.js"], env: { VAULT_ADDR: "https://v.example" } };

test("mergeServerEntry creates the file shape when nothing exists", () => {
  const out = JSON.parse(mergeServerEntry(undefined, "vault-dev-broker", entry));
  assert.deepEqual(out, { mcpServers: { "vault-dev-broker": entry } });
});

test("mergeServerEntry preserves other servers and replaces ours", () => {
  const existing = JSON.stringify({ mcpServers: { puppeteer: { command: "npx", args: ["-y", "x"] }, "vault-dev-broker": { command: "old" } } });
  const out = JSON.parse(mergeServerEntry(existing, "vault-dev-broker", entry));
  assert.deepEqual(Object.keys(out.mcpServers).sort(), ["puppeteer", "vault-dev-broker"]);
  assert.deepEqual(out.mcpServers["vault-dev-broker"], entry);
  assert.equal(out.mcpServers.puppeteer.command, "npx");
});

test("mergeServerEntry refuses invalid JSON rather than clobbering it", () => {
  assert.throws(() => mergeServerEntry("{ not json", "x", entry), /not valid JSON/);
});

test("parseArgs reads the subcommand and --flag=value / --flag value forms", () => {
  assert.deepEqual(parseArgs(["setup", "--vault-addr=https://v.example", "--issuer", "https://i.example"]), { cmd: "setup", flags: { "vault-addr": "https://v.example", issuer: "https://i.example" } });
  assert.deepEqual(parseArgs([]), { cmd: undefined, flags: {} });
});

test("setup without --issuer returns 1", async () => {
  assert.equal(await runCli(["setup", "--vault-addr", "https://v.example"]), 1);
});

test("detectClients reports the four known clients with presence", () => {
  const targets = detectClients("/home/u", false);
  assert.deepEqual(targets.map((t) => t.name), ["bob", "claude-code", "cursor", "windsurf"]);
  assert.equal(targets[0].file, "/home/u/.bob/settings/mcp.json");
  assert.equal(targets.every((t) => t.present === false), true);
});
