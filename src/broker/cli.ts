import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { TokenSource, openBrowser as defaultOpenBrowser } from "./auth";
import { issuerFromEnv } from "./discovery";

export type ServerEntry = { command: string; args: string[]; env: Record<string, string> };
export type ClientTarget = { name: string; file: string; present: boolean };

export function parseArgs(argv: string[]): { cmd: "setup" | "signin" | undefined; flags: Record<string, string> } {
  const cmd = argv[0] === "setup" || argv[0] === "signin" ? argv[0] : undefined;
  const flags: Record<string, string> = {};
  const rest = cmd ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else { flags[a.slice(2)] = rest[i + 1] ?? ""; i += 1; }
  }
  if (flags["login-token"] && flags["login-token"] !== "access" && flags["login-token"] !== "id") throw new Error("--login-token must be access or id");
  return { cmd, flags };
}

/** Merge our entry into an mcpServers file body. Other servers are preserved; ours is replaced. */
export function mergeServerEntry(existing: string | undefined, name: string, entry: ServerEntry): string {
  let doc: { mcpServers?: Record<string, unknown> } = {};
  if (existing && existing.trim()) {
    try { doc = JSON.parse(existing); } catch { throw new Error("existing config is not valid JSON; fix it by hand first"); }
  }
  doc.mcpServers = { ...(doc.mcpServers ?? {}), [name]: entry };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function detectClients(home: string, hasClaudeCli: boolean): ClientTarget[] {
  const t = (name: string, file: string, present: boolean): ClientTarget => ({ name, file, present });
  return [
    t("bob", join(home, ".bob", "settings", "mcp.json"), existsSync(join(home, ".bob"))),
    t("claude-code", join(home, ".claude.json"), hasClaudeCli || existsSync(join(home, ".claude.json"))),
    t("cursor", join(home, ".cursor", "mcp.json"), existsSync(join(home, ".cursor"))),
    t("windsurf", join(home, ".codeium", "windsurf", "mcp_config.json"), existsSync(join(home, ".codeium", "windsurf"))),
  ];
}

function hasCli(name: string): boolean {
  try { execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

function entryFromFlags(flags: Record<string, string>, brokerPath: string): ServerEntry {
  const env: Record<string, string> = { VAULT_ADDR: flags["vault-addr"]! };
  if (flags.issuer) env.OIDC_ISSUER = flags.issuer;
  if (flags["client-id"]) env.OIDC_CLIENT_ID = flags["client-id"];
  if (flags["login-token"]) env.OIDC_LOGIN_TOKEN = flags["login-token"];
  if (flags.scopes) env.OIDC_SCOPES = flags.scopes;
  if (flags["vault-mount"]) env.VAULT_JWT_MOUNT = flags["vault-mount"];
  if (flags["vault-namespace"]) env.VAULT_NAMESPACE = flags["vault-namespace"];
  if (flags.workspace) env.WORKSPACE_ROOT = resolve(flags.workspace);
  return { command: "node", args: [brokerPath], env };
}

/** `node broker.js setup [--vault-addr ...] [--issuer ...] [--client-id ...] [--login-token access|id] [--scopes "..."] [--vault-mount ...]` */
async function setup(flags: Record<string, string>): Promise<number> {
  if (!flags["vault-addr"]) { console.log("setup needs --vault-addr <url> (for example https://vault.example.com)"); return 1; }
  if (!flags.issuer) { console.log("setup needs --issuer <url> (for example https://<tenant>/oauth2 for IBM Verify)"); return 1; }
  if (!flags["client-id"]) { console.log("setup needs --client-id <id> (the public PKCE app's OIDC client id)"); return 1; }
  const home = process.env.HOME ?? "";
  const brokerPath = resolve(process.argv[1]);
  const entry = entryFromFlags(flags, brokerPath);
  const claudeCli = hasCli("claude");
  const targets = detectClients(home, claudeCli).filter((t) => t.present);
  if (targets.length === 0) { console.log("No supported client found (Bob, Claude Code, Cursor, Windsurf). Nothing written."); return 1; }
  for (const t of targets) {
    if (t.name === "claude-code" && claudeCli) {
      const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      if (existsSync(t.file)) { copyFileSync(t.file, `${t.file}.bak-${Date.now()}`); console.log(`claude-code: backed up ${t.file}`); }
      try { execFileSync("claude", ["mcp", "remove", "--scope", "user", "vault-dev-broker"], { stdio: "ignore" }); } catch { /* not present yet */ }
      execFileSync("claude", ["mcp", "add", "--scope", "user", "vault-dev-broker", ...envArgs, "--", entry.command, ...entry.args], { stdio: "inherit" });
      console.log(`claude-code: registered via claude mcp add (user scope)`);
      console.log(`  env: ${JSON.stringify(entry.env)}`);
      continue;
    }
    const existing = existsSync(t.file) ? readFileSync(t.file, "utf8") : undefined;
    const merged = mergeServerEntry(existing, "vault-dev-broker", entry);
    mkdirSync(dirname(t.file), { recursive: true });
    if (existing !== undefined) copyFileSync(t.file, `${t.file}.bak-${Date.now()}`);
    writeFileSync(t.file, merged);
    console.log(`${t.name}: wrote ${t.file}${existing !== undefined ? " (backup kept)" : ""}`);
    console.log(`  env: ${JSON.stringify(entry.env)}`);
  }
  console.log("\nNext: restart the client, then ask it to call vault_signin (or run: node broker.js signin now).");
  return 0;
}

/** `node broker.js signin` with the same flags: browser sign-in from a terminal so the first IDE use is silent. */
async function signin(flags: Record<string, string>): Promise<number> {
  let issuer: string | undefined;
  try { issuer = flags.issuer ? flags.issuer.replace(/\/$/, "") : issuerFromEnv(); } catch { /* reported below */ }
  const clientId = flags["client-id"] ?? process.env.OIDC_CLIENT_ID ?? process.env.VERIFY_CLIENT_ID;
  if (!issuer || !clientId) {
    console.log("signin needs --issuer <url> and --client-id <id> (or OIDC_ISSUER / OIDC_CLIENT_ID)");
    return 1;
  }
  const ts = new TokenSource({
    issuer,
    clientId,
    redirectHost: process.env.OIDC_REDIRECT_HOST ?? process.env.VERIFY_REDIRECT_HOST ?? "127.0.0.1",
    port: Number(process.env.OIDC_REDIRECT_PORT ?? process.env.VERIFY_REDIRECT_PORT ?? 41837),
    scopes: (flags.scopes ?? process.env.OIDC_SCOPES ?? "openid email profile").split(/\s+/).filter(Boolean),
    loginToken: (flags["login-token"] ?? process.env.OIDC_LOGIN_TOKEN) === "id" ? "id" : "access",
    openBrowser: (url) => { console.log(`Open this URL if no browser appeared: ${url}`); defaultOpenBrowser(url); },
  });
  if (await ts.currentLoginToken()) { console.log(`Already signed in to ${issuer} (refresh token in the keychain).`); return 0; }
  await ts.signInInteractive();
  console.log(`Signed in to ${issuer}.${process.platform === "darwin" ? " The refresh token is in the keychain if the provider issued one (Okta needs the offline_access scope)." : " Nothing is persisted on this platform; sign in again after each broker start."}`);
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  if (cmd === "setup") return setup(flags);
  if (cmd === "signin") return signin(flags);
  return -1;   // not a CLI invocation: start the MCP server
}
