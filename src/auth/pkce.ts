import { createHash, randomBytes } from "node:crypto";

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newVerifier(): string {
  return b64url(randomBytes(32)); // 43 chars, RFC 7636 section 4.1
}

export function challengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(p: {
  authorizeEndpoint: string; clientId: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, scope: p.scopes.join(" "),
    state: p.state, code_challenge: p.challenge, code_challenge_method: "S256",
  });
  return `${p.authorizeEndpoint}?${q}`;
}
