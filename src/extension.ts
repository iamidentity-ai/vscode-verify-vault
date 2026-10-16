import * as vscode from "vscode";
import { AUTH_ID } from "./constants";
import { VerifyAuthProvider } from "./auth/provider";
import { registerCommands } from "./commands";
import { registerBrokerDefinitions } from "./mcp/definitions";

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new VerifyAuthProvider(ctx);
  ctx.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(AUTH_ID, "IBM Verify", provider, { supportsMultipleAccounts: false }),
    vscode.window.registerUriHandler(provider),
  );
  registerCommands(ctx);
  registerBrokerDefinitions(ctx);
}

export function deactivate(): void {}
