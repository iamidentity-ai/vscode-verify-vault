/** Replaces every secret value in text. Longest first so a value that contains another is not half-masked. */
export function redact(text: string, secrets: string[]): string {
  // ponytail: covers the exact value plus its URL-encoded, base64, base64url and JSON-escaped forms. Best-effort guard for
  // accidental leaks, not a defence against a command that deliberately transforms a secret (hex, reversed, split, ...).
  const forms = secrets.filter((s) => s.length >= 4).flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url"), JSON.stringify(s).slice(1, -1)]);
  const ordered = [...new Set(forms)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of ordered) out = out.split(s).join("[redacted]");
  return out;
}

/** Redacts FIRST, then keeps the last `cap` characters, so a value straddling the cut cannot leak its tail. */
export function redactedTail(output: string, secrets: string[], cap: number): string {
  const full = redact(output, secrets);
  return full.length > cap ? "...\n" + full.slice(-cap) : full;
}
