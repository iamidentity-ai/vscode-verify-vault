import * as vscode from "vscode";
import { AUTH_ID, SCOPES } from "./constants";

export function getSession(createIfNone: boolean): Thenable<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession(AUTH_ID, SCOPES, createIfNone ? { createIfNone: true } : { silent: true });
}
