/**
 * Token issuance + access-token verification for the Google Drive MCP route. Mirrors gateway's
 * oauth/grants.ts but binds tokens to the DRIVE resource audience and re-checks its allowlist.
 *
 * The JWT crypto itself is resource-agnostic, so we reuse Only Care's proven signer/verifier
 * (same AUTH_SECRET) rather than duplicate the crypto — importing it does not change Only Care.
 */
import { signJwt, verifyJwt } from "@/mcp/onlycare-tds/oauth/tokens";
import { fingerprint } from "../http-auth";
import { resource, isMcpAllowed, ACCESS_TTL_SEC, REFRESH_TTL_SEC } from "./config";

export interface OAuthTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Mint an access+refresh pair for an authorized user, audience-bound to the DRIVE resource (RFC 8707). */
export function issueTokens(email: string, scope: string): OAuthTokens {
  const access_token = signJwt("access", email, ACCESS_TTL_SEC, { aud: resource(), scope });
  const refresh_token = signJwt("refresh", email, REFRESH_TTL_SEC, { aud: resource(), scope });
  return { access_token, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token, scope };
}

export interface OAuthPrincipal {
  user: string;
  tokenFp: string;
}

/**
 * Verify a bearer access token for the Drive route: valid signature, not expired, audience == the
 * DRIVE resource, and the subject is still allowlisted. The audience check is what keeps an Only Care /
 * Hima / Gateway token from ever working here (and vice-versa).
 */
export function authenticateOAuth(token: string | null | undefined): OAuthPrincipal | null {
  const c = verifyJwt(token, "access");
  if (!c) return null;
  if (c.aud !== resource()) return null;
  if (!isMcpAllowed(c.sub)) return null;
  return { user: c.sub, tokenFp: fingerprint(token as string) };
}

// Best-effort single-use for authorization codes (own set, independent of the other endpoints').
const usedCodes = new Set<string>();
export function claimCode(code: string): boolean {
  if (usedCodes.has(code)) return false;
  usedCodes.add(code);
  if (usedCodes.size > 5000) usedCodes.clear();
  return true;
}
