export type VaultRef = { kind: "kv1" | "kv2" | "dyn"; mount: string; path: string; field: string };
// field is optional-and-unused here: the brief's tests read `.field` off a Ref without
// narrowing first, which needs the literal branch to declare the property (as undefined).
export type Ref = VaultRef | { kind: "literal"; value: string; field?: undefined };
export type EnvEntry = { name: string; ref: Ref };

// Grammar borrowed from Tyler Lynch's openshell-driver-hashicorp-vault so a .env.vault file
// means the same thing on a laptop and inside an OpenShell sandbox. The KV version is
// always stated: v1 and v2 are different APIs, so a bare vault+kv:// is an error.
const REF = /^vault\+(kv1|kv2|dyn):\/\/([^/#\s]+)\/([^#\s]+)(?:#([A-Za-z0-9_.-]+))?$/;

export function parseRef(raw: string): Ref {
  if (raw.startsWith("literal:")) return { kind: "literal", value: raw.slice("literal:".length) };
  if (raw.startsWith("vault+")) {
    const m = REF.exec(raw);
    if (!m) throw new Error("malformed vault+ reference (expected vault+kv1|kv2|dyn://<mount>/<path>#<field>)");
    return { kind: m[1] as VaultRef["kind"], mount: m[2], path: m[3], field: m[4] ?? "value" };
  }
  return { kind: "literal", value: raw };
}

export function parseEnvFile(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq < 1) throw new Error(`line ${i + 1}: expected NAME=value`);
    const name = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`line ${i + 1}: bad variable name ${name}`);
    let raw = t.slice(eq + 1).trim();
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) raw = raw.slice(1, -1);
    let ref: Ref;
    try { ref = parseRef(raw); } catch { throw new Error(`line ${i + 1}: ${name} has a malformed vault+ reference (expected vault+kv1|kv2|dyn://<mount>/<path>#<field>)`); }
    out.push({ name, ref });
  });
  return out;
}

/** Starter file written by the vault_init tool. Both lines resolve for every developer under the dev-secrets policy. */
export function starterEnvFile(): string {
  return [
    "# References resolve from Vault at run time; the agent never sees values.",
    "# vault+kv2://<mount>/<path>#<field>   vault+kv1://...   vault+dyn://...   literal:<value>   plain literals",
    "DEMO_SECRET=vault+kv2://secret/dev/shared/demo#value",
    "PORT=5432",
    "",
  ].join("\n");
}
