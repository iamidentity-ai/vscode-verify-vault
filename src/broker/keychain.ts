import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVICE = "verify-vault-broker";

// ponytail: macOS keychain only (/usr/bin/security). On other platforms the refresh token stays in memory,
// so the developer signs in again after each broker start. Add libsecret / Credential Manager when needed.
export async function keychainGet(account: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function keychainSet(account: string, value: string): Promise<void> {
  if (process.platform !== "darwin") return;
  if (/[\r\n\0]/.test(value + account)) throw new Error("keychain write failed: value contains a line break");   // one command per line in `security -i`
  // -U updates in place. The value goes to `security -i` on stdin, not argv, so it never shows in `ps`. Inside double quotes,
  // only backslash and double quote need escaping (probed on macOS). Never rethrow execFile's own error: its message embeds argv.
  const child = execFile("/usr/bin/security", ["-i"]);
  let err = "";
  child.stdin?.on("error", () => {});   // early exit of security must not raise an unhandled EPIPE
  child.stderr?.on("data", (d) => { err += d; });
  child.stdin?.end(`add-generic-password -U -s ${SERVICE} -a "${account.replace(/[\\"]/g, "\\$&")}" -w "${value.replace(/[\\"]/g, "\\$&")}"\n`);
  // `security -i` returns the last command's status; check both the exit code and stderr.
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve).on("error", () => resolve(-1)));
  if (code !== 0 || err.trim()) throw new Error(`keychain write failed: ${err.trim() || "security returned an error"}`);
}

export async function keychainDelete(account: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", account]).catch(() => undefined);
}
