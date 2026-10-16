import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { parseEnvFile, starterEnvFile } from "./envfile";
import { resolveEntries } from "./resolve";
import { redact, redactedTail } from "./redact";
import { runCommand } from "./run";
import { VaultClient, isExpired } from "./vault";
import { TokenSource } from "./auth";
import { runCli } from "./cli";
import { issuerFromEnv } from "./discovery";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required in the broker environment`);
  return v;
};

async function main(): Promise<void> {
// Two ways to get the developer's token:
//   VS Code extension:  VERIFY_ACCESS_TOKEN in the env (the extension resolved the session).
//   Standalone (Bob, Claude Code, Cursor): TokenSource signs in through the browser and keeps the refresh token in the keychain.
const env = (oidc: string, legacy: string, dflt: string): string => process.env[oidc] ?? process.env[legacy] ?? dflt;
const LOGIN_TOKEN = (process.env.OIDC_LOGIN_TOKEN === "id" ? "id" : "access") as "access" | "id";

const envToken = process.env.VERIFY_ACCESS_TOKEN;
// Standalone mode (no VERIFY_ACCESS_TOKEN) needs OIDC_ISSUER and OIDC_CLIENT_ID to sign in, but a
// missing one must not crash the whole broker at startup: tools/list still has to work so the
// client can at least see the tools exist. Defer the error to the first call that needs a token.
let ISSUER: string | undefined;
let CLIENT_ID: string | undefined;
let tokensInitError: string | undefined;
if (!envToken) {
  try {
    ISSUER = issuerFromEnv();
    CLIENT_ID = env("OIDC_CLIENT_ID", "VERIFY_CLIENT_ID", "");
    if (!CLIENT_ID) throw new Error("Set OIDC_CLIENT_ID (the public PKCE app's client id)");
  } catch (e) {
    tokensInitError = (e as Error).message;
  }
}
const tokens = envToken || tokensInitError ? undefined : new TokenSource({
  issuer: ISSUER!,
  clientId: CLIENT_ID!,
  redirectHost: env("OIDC_REDIRECT_HOST", "VERIFY_REDIRECT_HOST", "127.0.0.1"),
  port: Number(env("OIDC_REDIRECT_PORT", "VERIFY_REDIRECT_PORT", "41837")),
  scopes: (process.env.OIDC_SCOPES ?? "openid email profile").split(/\s+/).filter(Boolean),
  loginToken: LOGIN_TOKEN,
});

/** Every token this process has held (access and id). All of them are redacted from every tool result. */
const seenTokens = new Set<string>(envToken ? [envToken] : []);

const EXPIRED_MSG = "The VS Code sign-in token has expired. Run 'MCP: List Servers' and restart 'Vault dev broker (IBM Verify)'.";

async function subjectJwt(): Promise<string> {
  if (envToken) {
    if (isExpired(envToken)) throw new Error(EXPIRED_MSG);
    seenTokens.add(envToken);
    return envToken;
  }
  if (!tokens) throw new Error("Not signed in. Set OIDC_ISSUER and OIDC_CLIENT_ID, then call vault_signin.");
  const t = await tokens.currentLoginToken();
  if (!t) throw new Error("Not signed in. Call the vault_signin tool first.");
  seenTokens.add(t);
  return t;
}
/** Redaction set: every token ever seen plus both tokens currently held (access and id), whichever mode is active. */
const secretsNow = (): string[] => [...seenTokens, ...(tokens?.held() ?? [])];

const vault = new VaultClient({
  addr: need("VAULT_ADDR"),
  jwtMount: process.env.VAULT_JWT_MOUNT ?? "verify-dev",
  jwtRole: process.env.VAULT_JWT_ROLE ?? "developer",
  namespace: process.env.VAULT_NAMESPACE || undefined,
  getSubjectJwt: subjectJwt,
});
// Defaults to the client's working directory. Proven for Claude Code (cwd = the open project); Bob and Cursor should set WORKSPACE_ROOT (or "cwd" where supported) until proven.
const workspace = resolvePath(process.env.WORKSPACE_ROOT ?? process.cwd());

async function load(envFile: string) {
  const file = resolvePath(workspace, envFile);
  if (file !== workspace && !file.startsWith(workspace + sep)) throw new Error("envFile must be inside the workspace");
  return parseEnvFile(await readFile(file, "utf8"));
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const OUTPUT_TAIL = 8000;

const server = new McpServer({ name: "vault-dev-broker", version: "0.3.4" });

const sleep = (ms: number) => new Promise<"pending">((r) => setTimeout(() => r("pending"), ms));

async function whoami(): Promise<string> {
  const login = await subjectJwt();
  // envToken (VS Code path) never reaches this function with ISSUER unset today, since vault_signin
  // returns before calling whoami() in that case, but guard directly rather than depend on that.
  if (envToken) return "Signed in through the VS Code session";
  const access = (await tokens!.currentAccessToken()) ?? login;
  seenTokens.add(access);
  const userinfo = (await tokens!.discovery()).userinfo_endpoint;
  if (!userinfo) return "Signed in (the provider publishes no userinfo endpoint)";
  const res = await fetch(userinfo, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`userinfo ${res.status}: the token was not accepted; call vault_signin again`);
  const me = (await res.json()) as { email?: string; preferred_username?: string; sub?: string };
  return `Signed in to ${ISSUER} as ${me.email ?? me.preferred_username ?? me.sub ?? "unknown"}`;
}

server.registerTool(
  "vault_signin",
  {
    description: "Sign in to the identity provider (opens the browser). Only needed when the broker runs outside VS Code. Call it again after finishing in the browser to confirm.",
    inputSchema: {},
  },
  async () => {
    try {
      if (envToken) return isExpired(envToken) ? { isError: true, ...text(EXPIRED_MSG) } : text("Signed in through the VS Code session; nothing to do.");
      if (!tokens) return { isError: true, ...text(tokensInitError ?? "Not configured.") };
      if (await tokens.currentLoginToken()) return text(await whoami());
      const outcome = await Promise.race([tokens!.signInInteractive().then(() => "done" as const), sleep(20_000)]);
      if (outcome === "done") return text(await whoami());
      const last = tokens!.lastError ? `Last sign-in error: ${tokens!.lastError}. ` : "";
      return text(redact(`${last}Browser opened for sign-in. If no browser appeared, open this URL yourself: ${tokens!.authorizeUrl ?? "(unavailable)"} . Finish there, then call vault_signin again to confirm.`, secretsNow()));
    } catch (e) {
      return { isError: true, ...text(redact(`Sign-in failed: ${(e as Error).message}`, secretsNow())) };
    }
  },
);

server.registerTool(
  "vault_signout",
  {
    description: "Sign out: revokes the stored refresh token at the provider and removes it from the keychain. The current access token stays valid until it expires.",
    inputSchema: {},
  },
  async () => {
    if (envToken) return text("Sign out from VS Code's Accounts menu");
    if (!tokens) return { isError: true, ...text(tokensInitError ?? "Not configured.") };
    await tokens.signOut();
    return text("Signed out");
  },
);

server.registerTool(
  "vault_init",
  {
    description: "Create a starter .env.vault in the workspace (two demo references) if none exists, or list the variable names of the existing one. Never returns values.",
    inputSchema: { envFile: z.string().default(".env.vault") },
  },
  async ({ envFile }) => {
    if (workspace === "/" || workspace === (process.env.HOME ?? "").replace(/\/$/, "")) throw new Error(`Refusing to create ${envFile} in ${workspace}: open a project, or set WORKSPACE_ROOT to the project directory`);
    const file = resolvePath(workspace, envFile);
    if (file !== workspace && !file.startsWith(workspace + sep)) throw new Error("envFile must be inside the workspace");
    if (existsSync(file)) {
      const names = parseEnvFile(await readFile(file, "utf8")).map((e) => e.name);
      return text(`${envFile} already exists with ${names.length} variable(s): ${names.join(", ")}`);
    }
    await writeFile(file, starterEnvFile(), { flag: "wx" });
    return text(`Created ${envFile} in ${workspace} with DEMO_SECRET (a Vault reference) and PORT (a literal). Edit it, then use vault_check.`);
  },
);

server.registerTool(
  "vault_check",
  {
    description: "Report which references in a .env.vault file resolve from HashiCorp Vault for the signed-in developer. Never returns secret values.",
    inputSchema: { envFile: z.string().default(".env.vault").describe("Path relative to the workspace root") },
  },
  async ({ envFile }) => {
    try {
      await subjectJwt();
      const { report } = await resolveEntries(await load(envFile), vault);
      return text(redact(report.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name} <- ${r.source}${r.error ? `: ${r.error}` : ""}`).join("\n") || "(empty file)", secretsNow()));
    } finally {
      await vault.revokeLeases();
    }
  },
);

server.registerTool(
  "vault_run",
  {
    description: "Run a shell command with the variables from a .env.vault file resolved from HashiCorp Vault and injected into its environment. Secret values are never returned; any that appear in the output are redacted. Use this instead of asking for a secret.",
    inputSchema: {
      command: z.string().describe("Shell command, run with /bin/sh -c in the workspace root"),
      envFile: z.string().default(".env.vault"),
      timeoutSeconds: z.number().int().min(1).max(600).default(120),
    },
  },
  async ({ command, envFile, timeoutSeconds }) => {
    try {
      await subjectJwt();
      const { env, secretValues, report } = await resolveEntries(await load(envFile), vault);
      const failed = report.filter((r) => !r.ok);
      if (failed.length) {
        return { isError: true, ...text(redact(`Refusing to run: ${failed.length} reference(s) failed to resolve\n` + failed.map((f) => `${f.name} <- ${f.source}: ${f.error}`).join("\n"), secretsNow())) };
      }
      const r = await runCommand(command, env, workspace, timeoutSeconds * 1000);
      const secrets = [...secretValues, ...secretsNow()];
      const head = `resolved ${report.length} variable(s): ${report.map((x) => x.name).join(", ")}\nexit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n\n`;
      return { isError: r.exitCode !== 0, ...text(redact(head, secrets) + redactedTail(r.output, secrets, OUTPUT_TAIL)) };
    } finally {
      await vault.revokeLeases();
    }
  },
);

server.connect(new StdioServerTransport()).catch((e) => {
  console.error("broker failed to start:", e);
  process.exit(1);
});
}

runCli(process.argv.slice(2)).then((code) => {
  if (code >= 0) { process.exitCode = code; return; }   // let stdout flush; never process.exit() after console.log
  return main();
}).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
