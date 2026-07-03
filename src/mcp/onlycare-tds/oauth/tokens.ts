/**
 * Compact HS256 JWTs for the Only Care TDS OAuth server, signed with the app's AUTH_SECRET
 * (same key as the portal session cookie, but a different, unambiguous format + an explicit
 * `tu` "token use" claim, so the two can never be confused).
 *
 * Three token uses:
 *  - "code"    short-lived authorization code (carries the PKCE challenge + grant params)
 *  - "access"  bearer token the MCP route validates (aud = the resource URL)
 *  - "refresh" longer-lived token to mint fresh access tokens
 *
 * Fully stateless: nothing is persisted. Per-user revocation is enforced separately by the
 * email allowlist at call time (see oauth/config.ts), not by a token store.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { envVar } from "../env";

export type TokenUse = "code" | "access" | "refresh" | "client";

function key(): Buffer {
  const s = envVar("AUTH_SECRET");
  if (!s) throw new Error("AUTH_SECRET is not configured — cannot sign OAuth tokens");
  return Buffer.from(s);
}

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowSec = (): number => Math.floor(Date.now() / 1000);

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface Claims {
  tu: TokenUse;
  sub: string;              // user email
  iat: number;
  exp: number;
  [k: string]: unknown;
}

/** Sign a JWT with the given claims and TTL. `tu` disambiguates the token's purpose. */
export function signJwt(tu: TokenUse, sub: string, ttlSec: number, extra: Record<string, unknown> = {}): string {
  const iat = nowSec();
  const header = enc({ alg: "HS256", typ: "JWT" });
  const payload = enc({ tu, sub, iat, exp: iat + ttlSec, ...extra } satisfies Claims);
  const signingInput = `${header}.${payload}`;
  const sig = createHmac("sha256", key()).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/** Verify signature + expiry + expected `tu`. Returns claims, or null if anything is off. */
export function verifyJwt(token: string | null | undefined, expect: TokenUse): Claims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = createHmac("sha256", key()).update(`${h}.${p}`).digest("base64url");
  if (!safeEqualStr(s, expected)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.tu !== expect) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowSec()) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  return claims;
}
