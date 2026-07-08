/**
 * OAuth server configuration for the invoice-intelligence MCP resource.
 *
 * Mirrors Hima's oauth/config.ts: a co-located authorization server whose issuer is the resource URL
 * itself (path-based, https://host/mcp/invoice-intelligence), discovered by RFC 8414 path-insertion
 * (/.well-known/oauth-authorization-server/mcp/invoice-intelligence). This does NOT collide with the
 * root well-known paths (claimed by Only Care) or with Hima/Gateway's path-based servers — every
 * endpoint stays fully independent while binding tokens to its own audience (RFC 8707).
 *
 * Identity reuses the portal login (email + team password → session cookie); authorization is a tight
 * email allowlist enforced at call time. Revoke by removing an email from
 * INVOICE_INTEL_MCP_ALLOWED_EMAILS + `pm2 restart innovfin` (per-user, no token store).
 */
import { envVar } from "../env";

/** Public origin the endpoint is served from. Override per-env with INVOICE_INTEL_MCP_ORIGIN. */
export function origin(): string {
  return (envVar("INVOICE_INTEL_MCP_ORIGIN") ?? "https://gst.innovfix.ai").replace(/\/$/, "");
}

/** The MCP resource identifier (RFC 8707 audience). */
export function resource(): string {
  return `${origin()}/mcp/invoice-intelligence`;
}
/** OAuth issuer = the resource URL (co-located AS, path-based). AS metadata is discovered by
 *  RFC 8414 path-insertion at /.well-known/oauth-authorization-server/mcp/invoice-intelligence. */
export function issuer(): string {
  return resource();
}

/** OAuth endpoint URLs (live under the MCP path; served by app routes, reached via rewrites for well-known). */
export const oauthPaths = {
  authorize: "/mcp/invoice-intelligence/oauth/authorize",
  token: "/mcp/invoice-intelligence/oauth/token",
  register: "/mcp/invoice-intelligence/oauth/register",
} as const;

export function authorizationEndpoint(): string { return origin() + oauthPaths.authorize; }
export function tokenEndpoint(): string { return origin() + oauthPaths.token; }
export function registrationEndpoint(): string { return origin() + oauthPaths.register; }
/** Where the 401 WWW-Authenticate header points the client for Protected Resource Metadata (RFC 9728). */
export function protectedResourceMetadataUrl(): string {
  return `${origin()}/.well-known/oauth-protected-resource/mcp/invoice-intelligence`;
}

export const SCOPES = ["mcp"] as const;
export const CODE_TTL_SEC = 120;                 // authorization code: short-lived
export const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // access token: 30 days
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 180;

/** Emails permitted to use the invoice-intelligence MCP (defaults to the same finance team). */
export function allowedEmails(): string[] {
  const env = envVar("INVOICE_INTEL_MCP_ALLOWED_EMAILS");
  const list = env
    ? env.split(",")
    : ["jp@innovfix.in", "shoyab@innovfix.in", "fida@innovfix.in"];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function isMcpAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
