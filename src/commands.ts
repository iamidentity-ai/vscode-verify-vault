import * as vscode from "vscode";
import { getSession } from "./session";
import { VaultClient } from "./broker/vault";

export function registerCommands(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("verifyVault.signIn", async () => {
      const s = await getSession(true);
      if (s) vscode.window.showInformationMessage(`Signed in to IBM Verify as ${s.account.label}`);
    }),
    vscode.commands.registerCommand("verifyVault.copyToken", async () => {
      const s = await getSession(true);
      if (!s) return;
      await vscode.env.clipboard.writeText(s.accessToken);
      // Wipe only if the clipboard still holds the token, so a later copy is not destroyed.
      setTimeout(async () => { if ((await vscode.env.clipboard.readText()) === s.accessToken) await vscode.env.clipboard.writeText(""); }, 60_000);
      vscode.window.showWarningMessage("IBM Verify access token copied to the clipboard and cleared after 60 seconds. Dev aid only. It expires within an hour.");
    }),
    vscode.commands.registerCommand("verifyVault.putSecret", async () => {
      const s = await getSession(true);
      if (!s) return;
      const cfg = vscode.workspace.getConfiguration("verifyVault");
      if (!cfg.get<string>("vaultAddr", "")) { vscode.window.showErrorMessage("Set verifyVault.vaultAddr (for example https://vault.example.com)"); return; }
      const name = await vscode.window.showInputBox({
        prompt: "Secret name (stored under your personal Vault path)",
        ignoreFocusOut: true,
        validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? undefined : "letters, digits and _ only, not starting with a digit (it becomes an env var name)"),
      });
      if (!name) return;
      const value = await vscode.window.showInputBox({ prompt: `Value for ${name}. It goes to Vault and is never shown to the agent.`, password: true, ignoreFocusOut: true });
      if (value === undefined || value === "") return;
      const vault = new VaultClient({
        addr: cfg.get<string>("vaultAddr", ""),
        jwtMount: cfg.get<string>("vaultJwtMount", "verify-dev"),
        jwtRole: cfg.get<string>("vaultJwtRole", "developer"),
        getSubjectJwt: async () => s.accessToken,
        namespace: cfg.get<string>("vaultNamespace", "") || undefined,
      });
      try {
        const ref = await vault.putUserSecret(name, value);
        await vscode.env.clipboard.writeText(`${name.toUpperCase()}=${ref}`);
        vscode.window.showInformationMessage(`Stored in Vault. A .env.vault line was copied to the clipboard: ${name.toUpperCase()}=${ref}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Vault write failed: ${(e as Error).message}`);
      }
    }),
  );
}
