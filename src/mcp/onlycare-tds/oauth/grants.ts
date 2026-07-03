/**
 * Token issuance + access-token verification for the MCP route.
 *
 * Access/refresh tokens are stateless JWTs. Authorization is re-checked at every step against the
 * email allowlist (config.isMcpAllowed), so removing a user from ONLYCARE_MCP_ALLOWED_EMAILS +
 * restarting revokes them even though tokens aren't stored.
 */
import { signJwt, verifyJwt } from "./tokens";
import { fingerprint } from "../http-auth";
import { resource, isMcpAllowed, ACCESS_TTL_SEC, REFRESH_TTL_SEC } from "./config";

export interface OAuthTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Mint an access+refresh pair for an authorized user, audience-bound to this resource (RFC 8707). */
export function issueTokens(email: string, scope: string): OAuthTokens {
  const access_token = signJwt("access", email, ACCESS_TTL_SEC, { aud: resource(), scope });
  const refresh_token = signJwt("refresh", email, REFRESH_TTL_SEC, { scope });
  return { access_token, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token, scope };
}

export interface OAuthPrincipal {
  user: string;   // authenticated email
  tokenFp: string;
}

/**
 * Verify a bearer access token for the MCP route: valid signature, not expired, audience == this
 * resource, and the subject is still allowlisted. Returns the principal (email) or null.
 */
export function authenticateOAuth(token: string | null | undefined): OAuthPrincipal | null {
  const c = verifyJwt(token, "access");
  if (!c) return null;
  if (c.aud !== resource()) return null;           // RFC 8707 audience binding — reject wrong-resource tokens
  if (!isMcpAllowed(c.sub)) return null;            // revocation via allowlist
  return { user: c.sub, tokenFp: fingerprint(token as string) };
}

// Best-effort single-use for authorization codes (codes are short-lived; a restart clearing this
// set is harmless since codes expire in CODE_TTL_SEC anyway).
const usedCodes = new Set<string>();
export function claimCode(code: string): boolean {
  if (usedCodes.has(code)) return false;
  usedCodes.add(code);
  if (usedCodes.size > 5000) usedCodes.clear(); // crude cap; codes expire fast so precision isn't needed
  return true;
}
