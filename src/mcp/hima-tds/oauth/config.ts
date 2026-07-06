/**
 * OAuth server configuration for the Hima TDS MCP resource.
 *
 * Mirrors Only Care's oauth/config.ts, with ONE deliberate difference: the issuer is the
 * resource URL itself (a co-located AS on the /mcp/hima-tds path), NOT the root origin.
 *   - Only Care claims the ROOT authorization-server metadata (/.well-known/oauth-authorization-server),
 *     so Hima cannot also use it — the well-known path is global and single-valued.
 *   - A path-based issuer is discovered by RFC 8414 path-insertion
 *     (/.well-known/oauth-authorization-server/mcp/hima-tds), which does NOT collide with Only Care.
 * This keeps the two OAuth servers fully independent — Only Care's live auth is untouched — while
 * each still binds tokens to its own audience (RFC 8707), as the MCP auth spec requires.
 *
 * Identity reuses the portal login (email + team password → session cookie); authorization is a
 * tight email allowlist enforced at call time. Revoke a user by removing their email from
 * HIMA_MCP_ALLOWED_EMAILS + `pm2 restart innovfin` (per-user, no token store).
 */
import { envVar } from "../env";

/** Public origin the endpoint is served from. Override per-env with HIMA_MCP_ORIGIN. */
export function origin(): string {
  return (envVar("HIMA_MCP_ORIGIN") ?? "https://gst.innovfix.ai").replace(/\/$/, "");
}

/** The MCP resource identifier (RFC 8707 audience). */
export function resource(): string {
  return `${origin()}/mcp/hima-tds`;
}
/** OAuth issuer = the resource URL (co-located AS, path-based). AS metadata is discovered by
 *  RFC 8414 path-insertion at /.well-known/oauth-authorization-server/mcp/hima-tds. */
export function issuer(): string {
  return resource();
}

/** OAuth endpoint URLs (live under the MCP path; served by app routes, reached via rewrites for well-known). */
export const oauthPaths = {
  authorize: "/mcp/hima-tds/oauth/authorize",
  token: "/mcp/hima-tds/oauth/token",
  register: "/mcp/hima-tds/oauth/register",
} as const;

export function authorizationEndpoint(): string { return origin() + oauthPaths.authorize; }
export function tokenEndpoint(): string { return origin() + oauthPaths.token; }
export function registrationEndpoint(): string { return origin() + oauthPaths.register; }
/** Where the 401 WWW-Authenticate header points the client for Protected Resource Metadata (RFC 9728). */
export function protectedResourceMetadataUrl(): string {
  return `${origin()}/.well-known/oauth-protected-resource/mcp/hima-tds`;
}

export const SCOPES = ["mcp"] as const;
export const CODE_TTL_SEC = 120;                 // authorization code: short-lived
export const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // access token: 30 days
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 180;

/** Emails permitted to use the Hima TDS MCP (defaults to JP/Shoyab/Fida — same finance team as Only Care). */
export function allowedEmails(): string[] {
  const env = envVar("HIMA_MCP_ALLOWED_EMAILS");
  const list = env
    ? env.split(",")
    : ["jp@innovfix.in", "shoyab@innovfix.in", "fida@innovfix.in"];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function isMcpAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
