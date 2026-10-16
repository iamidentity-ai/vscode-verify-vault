# Instructions for AI agents

This file is for an AI coding agent (Claude Code, GitHub Copilot, IBM Bob, Cursor, Codex) that has been asked to install or work on this repo. Humans: read README.md.

Prototype, not an IBM product, testing only.

## If the user says "install this"

Follow these steps in order. Report each check's real output. Stop and ask when an input is missing. Never ask the user for a secret.

### 1. Ask for the inputs you cannot discover

Ask for all of these in one message:

- Which client: the VS Code extension, or a standalone client (IBM Bob, Claude Code, Cursor, Windsurf).
- Identity provider issuer URL (IBM Verify: `https://<tenant>/oauth2`; Okta custom server: `https://<org>.okta.com/oauth2/default`).
- The OIDC client id of the app registered for this broker (public, PKCE). Not a secret.
- Vault address (for example `http://127.0.0.1:8200` or `https://vault.example.com`).
- The project folder the secrets are for.

Never ask for: a Vault root token, an API key, a password, an access token. If Vault still needs to be configured (step 5), the user runs that command in their own terminal.

### 2. Check prerequisites

```bash
node --version            # must print v20 or newer
git --version
gh --version               # optional: the release can also be downloaded from the browser
```

For the VS Code path also confirm the CLI exists: macOS `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --version`, Linux and Windows `code --version`.

### 3. Download the release

```bash
gh release download v0.3.4 --repo iamidentity-ai/vscode-verify-vault --pattern "broker.js" --dir ~/tools
gh release download v0.3.4 --repo iamidentity-ai/vscode-verify-vault --pattern "*.vsix" --dir ~/tools     # VS Code path only
```

### 4a. VS Code extension path

1. `"<code cli>" --install-extension ~/tools/verify-vault-0.3.4.vsix --force`, then ask the user to reload the window.
2. Write these user settings (edit `settings.json` or ask the user to set them in the Settings UI): `verifyVault.tenant` = the issuer WITHOUT the `/oauth2` suffix (for example `https://<tenant>`), `verifyVault.clientId`, `verifyVault.vaultAddr`, `verifyVault.vaultJwtMount` = `verify-dev`, `verifyVault.vaultJwtRole` = `developer`.
3. Tell the user the Verify app must have redirect URI `vscode://ibm.verify-vault/callback`, JWT access tokens with audience `vault-dev-broker`, refresh tokens on, and their user assigned. You cannot verify this; ask them to confirm.
4. Ask the user to run `IBM Verify Vault: Sign in` from the command palette and finish in the browser. Do not attempt the sign-in yourself.

### 4b. Standalone client path (Bob, Claude Code, Cursor, Windsurf)

```bash
node ~/tools/broker.js setup --vault-addr <vault address> --issuer <issuer> --client-id <client id> --workspace <project folder>
```

Add `--login-token id` for Okta, Entra, Auth0 or Keycloak (Verify uses the default, `access`), and `--scopes "openid email profile offline_access"` for Okta. The command prints which client configs it wrote and backs up any existing file. The identity provider app must allow the redirect URI `http://127.0.0.1:41837/callback`. Ask the user to restart the client, then either run `node ~/tools/broker.js signin --issuer <issuer> --client-id <client id>` themselves (add the same --login-token and --scopes flags used in setup) or ask the agent in that client to call `vault_signin`.

### 5. Vault configuration (user runs it, once per Vault)

If the Vault does not yet have the `verify-dev` mount, give the user this command to run in their own terminal (it needs a Vault root or admin token, which you must not handle):

```bash
VAULT_ADDR=<vault address> VAULT_TOKEN=<their token> ISSUER=<issuer> BOUND_CLIENT_ID=<client id> bash scripts/vault-setup.sh
```

Download the script with `gh api repos/iamidentity-ai/vscode-verify-vault/contents/scripts/vault-setup.sh -q .content | base64 -d > vault-setup.sh` if the repo is not cloned. For a non-Verify provider add `AUD=<client id> BOUND_CLIENT_ID=`. KV v2 must be mounted at `secret/`. Secrets must live under `secret/dev/shared/*` or `secret/dev/users/<sub>/*`, or the user extends the policy in the script.

### 6. Project setup

1. In the project folder create `.env.vault` (ask the user for the Vault paths; write references only, never values):
   ```
   ANTHROPIC_API_KEY=vault+kv2://secret/dev/shared/anthropic#api_key
   ```
   Or, once signed in, call the `vault_init` tool to write a starter file.
2. `.env.vault` holds no secrets and may be committed. Add `.env` to `.gitignore` if the project still has one, and remove any literal keys from it.
3. Append the block below to the project's agent instructions file (`.github/copilot-instructions.md` for VS Code chat, `CLAUDE.md` for Claude Code, `AGENTS.md` for Cursor and Codex, Bob's rules for Bob):

```
Secrets come from Vault through the vault-dev-broker MCP server. Never ask me for an API key, never write one into .env, a shell variable or code, and never read .env.vault for values. When a command needs a credential, run it with the vault_run tool; the values are injected for that command only. Use vault_check to see which references resolve and vault_init to create .env.vault. If a tool answers "Not signed in", call vault_signin and tell me to finish in the browser; call vault_signout when I ask to sign out.
```

### 7. Verify

- `vault_check` on `.env.vault` returns `ok` for every reference and no values.
- `vault_run` with `env | grep <one variable>` prints `<NAME>=[redacted]`.
- `vault_run` with `env | grep -c -e VERIFY_ACCESS_TOKEN -e VAULT_ -e OIDC_` prints `0` (the tool reports exit 1; that is grep finding nothing, and is the expected result).

Report the three results verbatim. Done.

## Rules when working on this repo

- Never commit `.env.vault`, `.mcp.json`, `.env`, tokens or keys. Fake values in docs carry `# pragma: allowlist secret`.
- Tests: `./node_modules/.bin/tsx --test tests/*.test.ts`; typecheck: `./node_modules/.bin/tsc -p tsconfig.json`; build: `npm run build`; package: `npm run package` (only the icon ships from `media/`).
- Commit messages carry no Co-Authored-By or AI attribution lines; check before committing; only the original clone has a local hook.
- Every tool result the broker returns passes through `redact()`; never add a tool that returns a secret value.
