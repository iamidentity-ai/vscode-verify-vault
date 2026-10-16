import * as vscode from "vscode";
import { AUTH_ID } from "../constants";
import { getSession } from "../session";

const LABEL = "Vault dev broker (IBM Verify)";

/** Starts dist/broker.js over stdio with the signed-in developer's Verify token in its environment. */
export function registerBrokerDefinitions(ctx: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const definition = (env: Record<string, string>, version: string) =>
    new vscode.McpStdioServerDefinition(LABEL, process.execPath, [ctx.asAbsolutePath("dist/broker.js")], env, version);

  ctx.subscriptions.push(
    changed,
    vscode.authentication.onDidChangeSessions((e) => { if (e.provider.id === AUTH_ID) changed.fire(); }),
    vscode.lm.registerMcpServerDefinitionProvider("verify-vault.broker", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () => [definition({}, (await getSession(false))?.id ?? "unsigned")],
      resolveMcpServerDefinition: async () => {
        const session = await getSession(true);
        if (!session) throw new Error("Sign in to IBM Verify to start the Vault dev broker");
        const cfg = vscode.workspace.getConfiguration("verifyVault");
        const vaultAddr = cfg.get<string>("vaultAddr", "");
        if (!vaultAddr) throw new Error("Set verifyVault.vaultAddr (for example https://vault.example.com)");
        // ponytail: the token is handed over once at start. When it expires (1h) the broker's next
        // Vault login fails and the user restarts the server; a token-refresh channel is the upgrade.
        return definition({
          VERIFY_ACCESS_TOKEN: session.accessToken,
          VAULT_ADDR: vaultAddr,
          VAULT_JWT_MOUNT: cfg.get<string>("vaultJwtMount", "verify-dev"),
          VAULT_JWT_ROLE: cfg.get<string>("vaultJwtRole", "developer"),
          VAULT_NAMESPACE: cfg.get<string>("vaultNamespace", ""),
          WORKSPACE_ROOT: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        }, session.id);
      },
    }),
  );
}
