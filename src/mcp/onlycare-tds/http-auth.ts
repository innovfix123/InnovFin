/**
 * Bearer-token auth for the networked Only Care TDS endpoint.
 *
 * Each user gets their own secret in `.env` as ONLYCARE_MCP_TOKEN_<USER> (e.g. ..._JP, ..._SHOYAB).
 * Tokens are per-user and independently revocable: delete one user's line + `pm2 restart innovfin`
 * and only that user loses access. No shared token, ever — this endpoint serves creator PANs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { envVarsWithPrefix } from "./env";

const PREFIX = "ONLYCARE_MCP_TOKEN_";

export interface Principal {
  /** Stable user label, derived from the env-var suffix (e.g. "JP", "SHOYAB"). */
  user: string;
  /** Short non-secret fingerprint of the presented token, safe to write to the audit log. */
  tokenFp: string;
}

/** Constant-time string compare via fixed-length SHA-256 digests (hides length + content timing). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** First 8 hex of sha256(token) — lets the audit log tie calls to a token without storing the secret. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/** Pull the raw bearer token from an Authorization header, or null. */
export function bearerFromRequest(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Resolve a presented token to a Principal, or null if it matches no configured user.
 * Compares against every configured token (constant-time each) so a match/no-match
 * decision doesn't leak which user — or whether any user — the token was close to.
 */
export function authenticate(token: string | null): Principal | null {
  if (!token) return null;
  let match: Principal | null = null;
  for (const [key, secret] of Object.entries(envVarsWithPrefix(PREFIX))) {
    if (!secret) continue;
    // Never short-circuit: check all, keep the match, so timing is independent of position/user.
    if (safeEqual(token, secret)) match = { user: key.slice(PREFIX.length), tokenFp: fingerprint(token) };
  }
  return match;
}

/** True if at least one user token is configured — used to fail loudly on a misconfigured deploy. */
export function hasConfiguredTokens(): boolean {
  return Object.keys(envVarsWithPrefix(PREFIX)).length > 0;
}
