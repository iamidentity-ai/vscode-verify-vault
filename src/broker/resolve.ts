import type { EnvEntry, VaultRef } from "./envfile";

export type Reader = { read(ref: VaultRef): Promise<string> };
export type ReportRow = { name: string; source: string; ok: boolean; error?: string };
export type Resolved = { env: Record<string, string>; secretValues: string[]; report: ReportRow[] };

/** Resolves every entry; failures are reported per row, never thrown, and values never enter the report. */
export async function resolveEntries(entries: EnvEntry[], reader: Reader): Promise<Resolved> {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  const report: ReportRow[] = [];
  for (const e of entries) {
    if (e.ref.kind === "literal") {
      env[e.name] = e.ref.value;
      report.push({ name: e.name, source: "literal", ok: true });
      continue;
    }
    const source = `${e.ref.kind}:${e.ref.mount}/${e.ref.path}#${e.ref.field}`;
    try {
      const v = await reader.read(e.ref);
      env[e.name] = v;
      if (v) secretValues.push(v);
      report.push({ name: e.name, source, ok: true });
    } catch (err) {
      report.push({ name: e.name, source, ok: false, error: (err as Error).message });
    }
  }
  return { env, secretValues, report };
}
