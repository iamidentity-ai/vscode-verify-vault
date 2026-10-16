import { spawn } from "node:child_process";

export type RunResult = { exitCode: number | null; output: string; timedOut: boolean };

// The developer's shell env carries ambient credentials such as GITHUB_TOKEN and cloud keys; the child gets
// only what a shell needs plus the resolved .env.vault values.
const ALLOWED_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "PWD", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"];

export function runCommand(cmd: string, env: Record<string, string>, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const base = Object.fromEntries(ALLOWED_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k] as string]));
    // detached so a timeout can kill grandchildren such as npm -> node that hold the pipe
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const cap = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: null, output: output + `\nspawn failed: ${e.message}`, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }); });
  });
}
