/**
 * PKCE (RFC 7636) verification for the authorization-code exchange.
 * We advertise S256 only (the secure method); "plain" is accepted defensively but never advertised.
 */
import { createHash, timingSafeEqual } from "node:crypto";

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True if `verifier` matches `challenge` under `method` (S256 = base64url(sha256(verifier))). */
export function verifyPkce(verifier: string, challenge: string, method: string = "S256"): boolean {
  if (!verifier || !challenge) return false;
  if (method === "S256") {
    const computed = createHash("sha256").update(verifier).digest("base64url");
    return safeEqualStr(computed, challenge);
  }
  if (method === "plain") return safeEqualStr(verifier, challenge);
  return false;
}
