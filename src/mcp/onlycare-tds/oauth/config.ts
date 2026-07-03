/**
 * OAuth server configuration for the Only Care TDS MCP resource.
 *
 * Identity is the existing portal login (email + team password → session cookie); this OAuth
 * layer turns that session into a bearer token Claude's native connector can obtain by URL.
 *
 * Authorization (who may actually use the resource) is a tight email allowlist enforced at
 * call time — NOT the same as the portal's broader ALLOWED_EMAILS. Revoke a user by removing
 * their email from ONLYCARE_MCP_ALLOWED_EMAILS + `pm2 restart innovfin` (per-user, no token store).
 */
import { envVar } from "../env";

/** Public origin the endpoint is served from. Override per-env with ONLYCARE_MCP_ORIGIN. */
export function origin(): string {
  return (envVar("ONLYCARE_MCP_ORIGIN") ?? "https://gst.innovfix.ai").replace(/\/$/, "");
}

/** The MCP resource identifier (RFC 8707 audience) and OAuth issuer. */
export function resource(): string {
  return `${origin()}/mcp/onlycare-tds`;
}
export function issuer(): string {
  return origin(); // root issuer → AS metadata at /.well-known/oauth-authorization-server (max compatibility)
}

/** OAuth endpoint URLs (live under the MCP path; served by app routes, reached via rewrites for well-known). */
export const oauthPaths = {
  authorize: "/mcp/onlycare-tds/oauth/authorize",
  token: "/mcp/onlycare-tds/oauth/token",
  register: "/mcp/onlycare-tds/oauth/register",
} as const;

export function authorizationEndpoint(): string { return origin() + oauthPaths.authorize; }
export function tokenEndpoint(): string { return origin() + oauthPaths.token; }
export function registrationEndpoint(): string { return origin() + oauthPaths.register; }
/** Where the 401 WWW-Authenticate header points the client for Protected Resource Metadata (RFC 9728). */
export function protectedResourceMetadataUrl(): string {
  return `${origin()}/.well-known/oauth-protected-resource/mcp/onlycare-tds`;
}

export const SCOPES = ["mcp"] as const;
export const CODE_TTL_SEC = 120;                 // authorization code: short-lived
export const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // access token: 30 days
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 180;

/** Emails permitted to use the Only Care TDS MCP (defaults to JP/Shoyab/Fida). */
export function allowedEmails(): string[] {
  const env = envVar("ONLYCARE_MCP_ALLOWED_EMAILS");
  const list = env
    ? env.split(",")
    : ["jp@innovfix.in", "shoyab@innovfix.in", "fida@innovfix.in"];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function isMcpAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
