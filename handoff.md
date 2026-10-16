# Handoff: first install on a new machine

Personal project, not an IBM product, not supported by IBM in any way, no support, use at your own risk. Requires an OIDC provider and a HashiCorp Vault instance. Read the README's "Before you start" section first.

## VS Code on a fresh laptop (Node 20 already there, a Verify PKCE app ready, a local Vault, secret paths known)

1. Install the extension: download `verify-vault-0.3.4.vsix` from https://github.com/iamidentity-ai/vscode-verify-vault/releases/tag/v0.3.4, then Extensions view, "Install from VSIX" (or `code --install-extension verify-vault-0.3.4.vsix`). Reload the window.
2. Check the Verify app once: redirect URI `vscode://ibm.verify-vault/callback` (and `vscode-insiders://ibm.verify-vault/callback` if you use Insiders), JWT access tokens with audience `vault-dev-broker`, refresh tokens on, your user assigned. Note the client id.
3. VS Code settings (search `verifyVault`): `tenant` = `https://<your-tenant>`, `clientId` = the client id, `vaultAddr` = `http://127.0.0.1:8200`, `vaultJwtMount` = `verify-dev`, `vaultJwtRole` = `developer`.
4. Teach Vault to trust Verify (needs the `vault` CLI and a root or admin token):
   ```bash
   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<root> ISSUER=https://<your-tenant>/oauth2 BOUND_CLIENT_ID=<client id> bash scripts/vault-setup.sh
   ```
   This creates the `verify-dev` jwt mount (via OIDC discovery), the `developer` role and the `dev-secrets` policy, and seeds `secret/dev/shared/demo`. KV v2 must already be mounted at `secret/`.
5. Put the secrets where the policy can see them: `secret/dev/shared/*` (everyone) or `secret/dev/users/<your sub>/*` (you). If they live elsewhere, copy them there or add their path to the policy in the script and re-run it.
6. In your project create `.env.vault`, one reference per secret:
   ```
   ANTHROPIC_API_KEY=vault+kv2://secret/dev/shared/anthropic#api_key
   JIRA_API_TOKEN=vault+kv2://secret/dev/shared/jira#api_token
   ```
7. Sign in: Cmd+Shift+P, `IBM Verify Vault: Sign in`, finish in the browser.
8. Tell the agent: copy the instruction block from the README section "Using it while coding" into `.github/copilot-instructions.md` (or `CLAUDE.md`, `AGENTS.md`).
9. Use it: open Chat in Agent mode (VS Code's chat runs on GitHub Copilot Chat), ask for `vault_check on .env.vault`, then `vault_run` with a command. The broker starts on first use; `MCP: List Servers` shows it.

## Any other client (IBM Bob, Claude Code, Cursor, Windsurf)

1. Download `broker.js` from the same release. Node 20 or newer.
2. `node broker.js setup --vault-addr http://127.0.0.1:8200 --issuer https://<your-tenant>/oauth2 --client-id <client id>` (add `--login-token id` for Okta, Entra, Auth0, Keycloak; `--workspace /path/to/project` for Bob and Cursor).
3. Steps 4 to 6 above are the same. The Verify app needs the loopback redirect `http://127.0.0.1:41837/callback`.
4. `node broker.js signin --issuer https://<your-tenant>/oauth2 --client-id <client id>` (add `--login-token id` where the provider needs it; `setup` writes the issuer into the client config only, a bare `signin` fails with "Set OIDC_ISSUER") (or ask the agent to call `vault_signin`), then `vault_check`, then `vault_run`.

## Backlog (not built, in priority order)

1. Agent identity: the broker acts as an agent on the developer's behalf (RFC 8693 token exchange with an actor token, RFC 9396 RAR scope on Vault paths, Vault OAuth resource server), which also narrows what a prompt-injected `vault_run` command can reach. Includes DPoP binding of the tokens and a probe of whether Vault enforces `cnf.jkt`.
2. `vault_dev`: launch a long-running dev server (for example `npm run dev`) in an editor terminal with the values injected; `vault_run` is capped at ten minutes.
3. Revocation latency: a Verify or Okta revoke does not stop Vault logins until the token expires (30 minutes). Options: shorter access-token lifetime on the app, or Vault-side introspection.
4. Refresh-token storage outside macOS (Windows Credential Manager, libsecret) and a Windows browser opener.
5. Local encrypted KV backend inside the broker for developers without a Vault (same `.env.vault` grammar, promotable to Vault later).
6. Sandboxed child for `vault_run` (OpenShell or NemoClaw egress substitution) so values never sit in a process the model controls.
7. `setup` for VS Code itself is not needed (the extension registers the broker), but a marketplace or Open VSX listing would replace the VSIX download.
