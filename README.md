# IBM Verify Vault for AI agents (VS Code)

> **Personal project. Not supported by IBM in any way.** This is not an IBM product. It is not supported, endorsed, reviewed, or officially created by IBM, and there is no support of any kind from anyone: no SLA, no help desk, no guaranteed fixes. Use it at your own risk. It is a prototype, not production software: use it only in test environments with test credentials.
>
> **Requirements:** an OIDC provider you control (IBM Verify, Okta, Entra, Auth0, Keycloak, ...) with an app registered for this tool, and a HashiCorp Vault instance you can configure (JWT auth mount, role, policy, KV v2). Neither is provided here.

New machine? Start with [handoff.md](handoff.md).

Prototype extension. The developer signs in with IBM Verify. The agent in VS Code chat gets a local MCP server, the Vault dev broker, whose only tools run commands with secrets resolved from HashiCorp Vault. The agent never receives a secret value.

## Why this is needed

AI coding agents run commands for you. Every command that talks to an LLM, Jira, Databricks or a database needs a credential, and today that credential usually sits in a `.env` file, a shell variable, or the chat itself. Once it is there, three things go wrong:

- The agent can read it, and anything the agent reads can end up in a transcript, a log, a commit, or a prompt-injected exfiltration.
- It never expires and nobody knows who used it. A leaked key works for everyone until someone notices.
- Every project and every laptop gets its own copy, so rotating a key means finding every copy.

Vault fixes the model, not the symptom. Secrets live in one place with policy and audit. You prove who you are with your normal sign-in (IBM Verify or any OIDC provider). Vault gives you a short-lived token scoped to what you may read. The broker injects the values into the one process that needs them and redacts them from anything the agent sees. The agent asks for a command to be run, never for a secret.

## Before you start (critical)

You need all of the following. Missing any one means the sign-in or the resolve step fails.

| Need | What exactly |
|---|---|
| Skills | Working knowledge of HashiCorp Vault (auth methods, policies, KV v2) and of OIDC (issuer, client id, redirect URI, scopes). This is not a zero-config tool. |
| A supported client | VS Code 1.104 or newer (the extension), or IBM Bob, Claude Code, Cursor, Windsurf (the standalone broker; Node 20 or newer). |
| A browser that can reach your identity provider | The sign-in happens in the browser and returns to `127.0.0.1:41837` (standalone broker; the VS Code extension returns to `vscode://`). |
| An OIDC identity provider with an app registered for the broker | See the identity provider table. |
| A HashiCorp Vault (2.0 or newer; Community edition is enough) reachable from your machine (HTTPS in real use; the throwaway local Vault is plain http) | See the Vault table. |
| A project that needs sensitive values | LLM keys, API tokens, personal access tokens, database passwords. |
| Those values already stored in Vault, and their paths | The path is what you write in `.env.vault`. |

### Identity provider

| Setting | IBM Verify | Any other OIDC provider (Okta, Entra, Auth0, Keycloak) |
|---|---|---|
| Discovery | `<issuer>/.well-known/openid-configuration` must resolve; the Verify issuer is `https://<tenant>/oauth2` | same rule; the issuer is what the discovery document reports |
| App type | OIDC, public client (no secret), PKCE required | native or public client, PKCE |
| Grants | authorization code, refresh token | authorization code, refresh token; Okta also needs the `offline_access` scope |
| Redirect URIs | `vscode://ibm.verify-vault/callback`, `vscode-insiders://ibm.verify-vault/callback`, `http://vault-dev.localhost:41837/callback`, `http://127.0.0.1:41837/callback` | `http://127.0.0.1:41837/callback` |
| Token given to Vault | JWT access token with a custom audience (`vault-dev-broker`); `--login-token access` | ID token (`aud` = client id); `--login-token id` |
| Users | assigned to the app (birthright or a group) | assigned to the app, plus an access policy on the authorization server (an Okta trial has none by default) |

### Vault

| Item | Value |
|---|---|
| Auth method | `jwt`, one mount per provider (for example `verify-dev`, `okta-dev`), configured with `oidc_discovery_url` set to the issuer |
| Role | `developer`: `role_type jwt`, `user_claim sub`, `bound_audiences` = the audience or client id above, `token_policies dev-secrets`, `token_ttl 30m`, `token_max_ttl 1h`; for IBM Verify also `bound_claims client_id=<client id>` (the script's `BOUND_CLIENT_ID`; set it empty for other providers) |
| Policy | `dev-secrets`: read `secret/data/dev/shared/*`; read and write `secret/data/dev/users/<your sub>/*`; nothing else |
| Secrets engine | KV v2 mounted at `secret/` |
| Scripts | `scripts/vault-setup.sh` creates the mount, config, role and policy and seeds `secret/dev/shared/demo`; KV v2 must already be mounted at `secret/` (`vault secrets enable -path=secret kv-v2`; a dev-mode Vault has it). `scripts/local-vault.sh` gives you a throwaway Vault on `127.0.0.1:8201` to try it |

### Store the values, note the paths

An admin (or you, on your own path) puts each value in once. Fake examples:

```bash
vault kv put secret/dev/shared/anthropic api_key=sk-ant-EXAMPLE-FAKE  # pragma: allowlist secret
vault kv put secret/dev/shared/jira email=charlie@example.com api_token=ATATT-EXAMPLE-FAKE  # pragma: allowlist secret
```

A reference in `.env.vault` is `vault+kv2://<mount>/<path>#<field>`, so those become:

```
ANTHROPIC_API_KEY=vault+kv2://secret/dev/shared/anthropic#api_key
JIRA_EMAIL=vault+kv2://secret/dev/shared/jira#email
JIRA_API_TOKEN=vault+kv2://secret/dev/shared/jira#api_token
PORT=5177
```

Personal values go under `secret/dev/users/<your sub>/...`; the VS Code command `IBM Verify Vault: Store a secret in Vault` writes one and copies the matching line for you.

## Using it while coding

Tell the agent once, in the project's instructions file (`CLAUDE.md`, `AGENTS.md`, or Bob's rules):

```
Secrets come from Vault through the vault-dev-broker MCP server. Never ask me for an API key, never write one into .env, a shell variable or code, and never read .env.vault for values. When a command needs a credential, run it with the vault_run tool; the values are injected for that command only. Use vault_check to see which references resolve and vault_init to create .env.vault. If a tool answers "Not signed in", call vault_signin and tell me to finish in the browser; call vault_signout when I ask to sign out.
```

A normal session then looks like this:

- You: "Run the Jira smoke test."
- Agent: calls `vault_check` (sees `ok JIRA_API_TOKEN`, no value), then `vault_run` with `npx tsx scripts/jira-smoke.ts`.
- Result: the script's output, with any credential that leaked into it shown as `[redacted]`.

If the agent ever asks you to paste a key, that is the moment to point it at `vault_run` instead.

## How it works

1. `IBM Verify Vault: Sign in` runs OIDC authorization code + PKCE against the tenant as a public client. The callback is `vscode://ibm.verify-vault/callback`. Tokens live in VS Code SecretStorage (the OS keychain). The callback authority is the extension id (`publisher.name`), the same for every user; it changes only for VS Code Insiders (`vscode-insiders://`) or a republish under another publisher, which must then be added to the Verify app.
2. VS Code starts `dist/broker.js` over stdio with the developer's Verify JWT in its environment.
3. The broker logs in to Vault at `auth/verify-dev/login` (a standard `jwt` auth mount bound to the tenant issuer and the app's `vault-dev-broker` audience). Vault templates the `dev-secrets` policy on the developer's `sub`, so every read is attributed to that person in the Vault audit log.
4. `vault_run` reads `.env.vault`, resolves `vault+kv2://mount/path#field` references, spawns the command with the values injected, makes a best-effort attempt to revoke any dynamic leases, and redacts any value that shows up in the output: no secret value is returned in a tool result. `vault_check` reports which references resolve.
5. `IBM Verify Vault: Store a secret in Vault` moves a literal into the developer's personal path and copies the matching `.env.vault` line.

## Quick VS Code install

Nine steps on a machine that has VS Code, Node 20 or newer, a Verify PKCE app and a reachable Vault.

1. **Install the extension.** Download `verify-vault-0.3.4.vsix` from the release page (https://github.com/iamidentity-ai/vscode-verify-vault/releases/tag/v0.3.4), then Extensions view, "Install from VSIX" (or `code --install-extension verify-vault-0.3.4.vsix`). Reload.
2. **Check the Verify app once.** It needs redirect URI `vscode://ibm.verify-vault/callback`, JWT access tokens with audience `vault-dev-broker`, refresh tokens on, and your user assigned. Note its client id.
3. **Point VS Code at your tenant and Vault.** Settings, search "verifyVault": tenant `https://<your-tenant>`, clientId from step 2, vaultAddr `http://127.0.0.1:8200`, mount `verify-dev`, role `developer`.
4. **Teach Vault to trust Verify.** With the `vault` CLI on PATH: `VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<root> ISSUER=https://<your-tenant>/oauth2 BOUND_CLIENT_ID=<client id> bash scripts/vault-setup.sh` (download the script from the repo). This creates the `verify-dev` mount, the `developer` role and the `dev-secrets` policy.
5. **Put the secrets where the policy can see them.** The policy reads `secret/dev/shared/*` and your own `secret/dev/users/<you>/*`. If your secrets live elsewhere, either copy them under `secret/dev/shared/` or add their path to the policy in the script and re-run it.
6. **In your project, create `.env.vault`** with references, one per secret: `ANTHROPIC_API_KEY=vault+kv2://secret/dev/shared/anthropic#api_key`.
7. **Sign in.** Cmd+Shift+P, `IBM Verify Vault: Sign in`, finish in the browser.
8. **Tell the agent.** Paste the instruction block from "Using it while coding" into the project's `.github/copilot-instructions.md` (or `CLAUDE.md`).
9. **Use it.** Open Chat in Agent mode (GitHub Copilot Chat is what VS Code's chat runs on), ask for `vault_check on .env.vault`, then `vault_run` with a command. The broker starts on first use; `MCP: List Servers` shows it.

Installing with an AI agent instead? Point it at this repo; [AGENTS.md](AGENTS.md) tells it what to do.

## Run outside VS Code (IBM Bob, Claude Code, Cursor, Windsurf)

The broker is a plain stdio MCP server. Without the extension it signs you in by itself: the first `vault_signin` opens the browser on your Verify tenant, the callback lands on http://127.0.0.1:41837/callback (loopback; set VERIFY_REDIRECT_HOST=vault-dev.localhost to use the .localhost alias instead), and the refresh token is kept in the macOS keychain (service `verify-vault-broker`) so later starts are silent. If no browser opens (Windows has no opener yet), vault_signin returns the URL to open by hand.

Download `broker.js` from the release (https://github.com/iamidentity-ai/vscode-verify-vault/releases/tag/v0.3.4), then:

```bash
node broker.js setup --vault-addr <url> --issuer https://<tenant>/oauth2 --client-id <client id>   # writes the mcpServers entry into every client it finds (backup kept)
node broker.js signin --issuer https://<tenant>/oauth2 --client-id <client id>   # optional: sign in now so the first use in the IDE is silent
```

`signin` takes the same flags as `setup` (`--issuer`, `--client-id`, `--login-token`, `--scopes`); both are required, from flags or from `OIDC_ISSUER`/`OIDC_CLIENT_ID` in the environment.

`setup` flags for another provider or Vault: `--vault-addr`, `--issuer`, `--client-id`, `--login-token access|id`, `--scopes "openid email profile offline_access"`, `--vault-mount`, `--vault-namespace`, `--workspace /abs/path` (writes `WORKSPACE_ROOT`). Restart the client. Ask the agent to call `vault_init` (creates a starter `.env.vault` in the workspace) and then `vault_check`. Without `WORKSPACE_ROOT` the broker uses the client's working directory; that is the open project in Claude Code (proven) and should be set explicitly for Bob and Cursor until proven. `vault_init` refuses to write into your home directory or `/`.

Build once instead of downloading: `npm install && npm run build`; the only file you need afterwards is `dist/broker.js`.

### Manual alternative

Edit the client's `mcpServers` JSON by hand instead of running `setup`.

IBM Bob (global `~/.bob/settings/mcp.json`, the file Bob already creates; or `.bob/mcp.json` in a project, which wins). Merge the entry into the existing `mcpServers` object rather than adding a second file; Bob ignores other filenames:

```json
{
  "mcpServers": {
    "vault-dev-broker": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/vscode-verify-vault/dist/broker.js"],
      "env": { "VAULT_ADDR": "https://vault.example.com", "WORKSPACE_ROOT": "/ABSOLUTE/PATH/your-project" }
    }
  }
}
```

Cursor ignores `cwd` in an MCP server entry; `WORKSPACE_ROOT` is what the broker actually reads to find `.env.vault`, so set it explicitly instead.

Claude Code:

```bash
claude mcp add vault-dev-broker -e VAULT_ADDR=https://vault.example.com -- node /ABSOLUTE/PATH/vscode-verify-vault/dist/broker.js
```

Cursor (`.cursor/mcp.json`) uses the same `mcpServers` shape as Bob.

First use: ask the agent to call `vault_signin`, finish in the browser, then `vault_check` on your `.env.vault`. Optional env: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_SCOPES`, `OIDC_LOGIN_TOKEN` (`access` or `id`; default `access`), `OIDC_REDIRECT_HOST`, `OIDC_REDIRECT_PORT`, `VAULT_JWT_MOUNT`, `VAULT_JWT_ROLE`, `VAULT_NAMESPACE`, `WORKSPACE_ROOT` (defaults to the working directory). The broker discovers the token/authorize/revoke endpoints from `<issuer>/.well-known/openid-configuration`, so it works against any OIDC provider, not just IBM Verify; `OIDC_LOGIN_TOKEN=id` presents the ID token to Vault instead of the access token, for providers where the access token is not meant for a third party like Vault, either because it is scoped to the provider's own APIs (Entra, Auth0, Keycloak) or opaque to begin with (Okta's org-authorization-server tokens). The legacy `VERIFY_TENANT`/`VERIFY_CLIENT_ID`/`VERIFY_REDIRECT_HOST`/`VERIFY_REDIRECT_PORT` names are still read as fallbacks. Note: `VERIFY_TENANT` used to be the bare tenant host (for example `https://<tenant>.verify.ibm.com`); the OIDC issuer is that host plus `/oauth2`, and the broker normalizes a bare `VERIFY_TENANT` for you. A refresh token stored under the old bare-host key is migrated automatically on first use. Either `OIDC_ISSUER` (or the legacy `VERIFY_TENANT`) and `OIDC_CLIENT_ID` (or `VERIFY_CLIENT_ID`) must be set for the standalone broker to sign in; there is no built-in default tenant.

Sign out: ask the agent to call `vault_signout` (it revokes the refresh token at the provider and removes it from the keychain), or run `security delete-generic-password -s verify-vault-broker -a "<issuer>|<client id>"` on macOS, which removes it locally only; the account is needed once more than one provider is stored. On Linux and Windows the refresh token is not stored, so sign in again after every broker start and whenever the access token expires (about an hour). The keychain item is readable by other processes running as you (same ceiling as the gh CLI). The access token already issued is not revoked; a running broker keeps it until it expires (about an hour), and the manual keychain delete revokes nothing.

### IBM Bob configuration

Install Node 20 or newer, download `broker.js` from the release (https://github.com/iamidentity-ai/vscode-verify-vault/releases/tag/v0.3.4), then either run `node broker.js setup --vault-addr <url> --issuer https://<tenant>/oauth2 --client-id <client id>` in the folder it landed in (writes `~/.bob/settings/mcp.json`, merging into any existing `mcpServers`) or add the entry to `~/.bob/settings/mcp.json` yourself. Open a project and ask Bob to call `vault_signin`.

## Providers

`setup`/`signin` work against any OIDC provider via discovery; only the flags change.

| Provider | `--issuer` | `--login-token` | Vault role (`scripts/vault-setup.sh` env) | Notes |
|---|---|---|---|---|
| IBM Verify | `https://<tenant>/oauth2` | `access` | `AUD=vault-dev-broker BOUND_CLIENT_ID=<client id>` (optional; binds the role to one app) | JWT access tokens with a custom audience |
| Okta (custom authorization server, e.g. `/oauth2/default`) | `https://<org>.okta.com/oauth2/default` | `id` | `AUD=<client id> BOUND_CLIENT_ID=` | proven 2026-09-16 with a local Vault on a trial tenant's default authorization server (a fresh trial's default server may have no access policy: create one, ALL_CLIENTS + authorization_code, or every sign-in fails); access tokens are JWTs too, `aud` is `api://default`, usable with `AUD=api://default --login-token access` (untested); add `offline_access` to `--scopes` for a refresh token |
| Okta (org authorization server, `https://<org>.okta.com`) | `https://<org>.okta.com` | `id` | `AUD=<client id> BOUND_CLIENT_ID=` | access tokens are opaque, not usable at Vault (untested); add `offline_access` to `--scopes` for a refresh token |
| Microsoft Entra | `https://login.microsoftonline.com/<tenant>/v2.0` | `id` | `AUD=<client id> BOUND_CLIENT_ID=` | untested; Entra backdates `iat` by 5 minutes, irrelevant to Vault |
| Auth0, Keycloak | `https://<domain>/` or `https://<host>/realms/<realm>` | `id` | `AUD=<client id> BOUND_CLIENT_ID=` | untested |

### Where the guarantee stops

The redaction above only protects the tool-result channel back to the model. `vault_run` executes any shell command the model chooses, with the resolved value in that command's environment. A command the model asks for, such as piping the value through `base64` or `rev`, or writing it to a file in the workspace that the editor then reads back, can move the value past the exact-substring match in `redact.ts` without it ever showing up as the literal string. The `ponytail` comment in `redact.ts` names the same ceiling for encoded forms; that comment covers the encoding half only, not the broader channel. Closing this needs two things, both planned rather than built: an agent-identity RAR scope that limits what the broker is even allowed to resolve on the agent's behalf, and running the child command in a sandbox (an OpenShell egress proxy, for example) that substitutes values at the network boundary instead of handing them to the process directly. The command's environment is an allowlist (PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TERM, TMPDIR, TZ, PWD, XDG_RUNTIME_DIR, SSH_AUTH_SOCK) plus the resolved values; your shell's own tokens are not passed through. Corporate proxy variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY), DOCKER_HOST, PYTHONPATH and similar are dropped too; pass any you need as literal lines in .env.vault (for example HTTPS_PROXY=http://proxy.example:8080). SSH_AUTH_SOCK is kept on purpose so git can push as you; remove it from the allowlist in run.ts if that is not wanted.

## Reference grammar (shared with the OpenShell Vault credential driver)

| Reference | Meaning |
|---|---|
| `vault+kv2://<mount>/<path>#<field>` | KV v2 read |
| `vault+kv1://<mount>/<path>#<field>` | KV v1 read |
| `vault+dyn://<mount>/<path>#<field>` | dynamic secret; lease revocation attempted (best effort) when the command exits |
| `literal:<value>` | force a literal that would otherwise parse as a reference |
| anything else | literal |

`#<field>` defaults to `value`.

Lease revocation is best effort: the `dev-secrets` policy grants no `sys/leases/revoke` capability today, so `revokeLeases()` fails and the failure is swallowed. The lease TTL is the real backstop until that grant is added. No dynamic mount is readable under `dev-secrets` yet, so this has not been exercised end to end.

## Setup

- Verify app: `VERIFY_TENANT_URL=https://<tenant>.verify.ibm.com VERIFY_ADMIN_CLIENT_ID=<admin api client id> VERIFY_ADMIN_SECRET=... npm run register-app`. All three are required; there is no default tenant. Optional env: `APP_NAME` (default `Vault dev broker`), `APP_URL` (default this repo's URL), `AUDIENCE` (default `vault-dev-broker`), `REDIRECT_URIS` (comma-separated; default the four broker/extension callbacks), `VERIFY_IDENTITY_SOURCE_IDS` (comma-separated identitysource ids; default every enabled identitysource on the tenant, since a Verify app with none set blocks every sign-in), `THEME_ID` (default `default`), `WRITE_APP_JSON=1` (also writes `verify-app.json`, gitignored; not written by default). Re-running finds the app by name and re-applies the redirect URIs; it only touches `identitySources` when `VERIFY_IDENTITY_SOURCE_IDS` is set, so a re-run never shrinks a working app's identity sources.
- Build and install: `npm run package` then `code --install-extension verify-vault-0.3.4.vsix`.
- Settings: `verifyVault.tenant`, `verifyVault.clientId`, `verifyVault.vaultAddr`, `verifyVault.vaultJwtMount`, `verifyVault.vaultJwtRole`, `verifyVault.vaultNamespace` (HCP Vault Dedicated uses `admin`).

## Not yet (next plan)

- Agent identity: RFC 8693 exchange with an actor token (JWT-SVID from Vault's SPIFFE engine) and RAR `vault:path_access`, presented to Vault's OAuth resource server. Today the broker acts as the developer only.
- The broker launched by the VS Code extension holds the access token it was started with. When that token expires (Verify's default is one hour), the tools answer with a message telling you to restart the server from `MCP: List Servers`. The standalone broker (Bob, Claude Code, Cursor, Windsurf) refreshes itself from the stored refresh token and does not have this limit. Raising the access-token lifetime on the Verify app removes the restart, but it widens the window in which a token revoked at Verify still logs in to Vault, because Vault's jwt auth validates the token locally and never asks Verify whether it was revoked. A refresh channel from the extension into the running broker is the planned fix. A shorter access-token lifetime for this app, or Vault-side introspection, would close that window so a revoked Verify token stops working at Vault before it expires.
- `IBM Verify Vault: Copy access token (dev aid)` puts the human's own short-lived token on the human's clipboard for the Vault login probe. No agent stores it; never echo it in a terminal.
- Refresh tokens outside macOS (libsecret, Windows Credential Manager).

## Why is this a Node file, and is that normal?

> Yes. This is how MCP servers work everywhere.
>
> - **Inside VS Code**, extensions that do real work run a helper process: the TypeScript checker, ESLint, Copilot's agent. VS Code ships its own Node and its docs say to run MCP servers with it. Our extension does exactly that, so you never install Node for the VS Code path.
> - **Outside VS Code** (Bob, Claude Code, Cursor), every MCP server is a small program the client starts for you. Look at any config: `"command": "npx"` or `"command": "uvx"`. Ours is `"command": "node"` with one file, `broker.js`. No `npm install`, no downloads at run time.
> - **What is different here**, and better: most MCP servers need a long-lived API key pasted into their config. This one has none. It signs you in through your identity provider and asks Vault for what it needs, when it needs it.

