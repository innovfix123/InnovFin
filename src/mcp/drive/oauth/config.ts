/**
 * OAuth server configuration for the Google Drive MCP resource.
 *
 * Like Hima / Gateway (and UNLIKE Only Care), the issuer is the resource URL itself — a co-located AS
 * on the /mcp/drive path, NOT the root origin (Only Care claims the root well-known AS-metadata paths).
 * The issuer is discovered by RFC 8414 path-insertion, so every OAuth server stays independent and
 * each binds tokens to its own audience (RFC 8707).
 *
 * Identity reuses the portal login (email + team password → session cookie); authorization is a tight
 * email allowlist enforced at call time. Revoke a user by removing their email from
 * DRIVE_MCP_ALLOWED_EMAILS + `pm2 restart innovfin` (per-user, no token store).
 */
import { envVar } from "../env";

/** Public origin the endpoint is served from. Override per-env with DRIVE_MCP_ORIGIN. */
export function origin(): string {
  return (envVar("DRIVE_MCP_ORIGIN") ?? "https://gst.innovfix.ai").replace(/\/$/, "");
}

/** The MCP resource identifier (RFC 8707 audience). */
export function resource(): string {
  return `${origin()}/mcp/drive`;
}
/** OAuth issuer = the resource URL (co-located AS, path-based). */
export function issuer(): string {
  return resource();
}

export const oauthPaths = {
  authorize: "/mcp/drive/oauth/authorize",
  token: "/mcp/drive/oauth/token",
  register: "/mcp/drive/oauth/register",
} as const;

export function authorizationEndpoint(): string { return origin() + oauthPaths.authorize; }
export function tokenEndpoint(): string { return origin() + oauthPaths.token; }
export function registrationEndpoint(): string { return origin() + oauthPaths.register; }
/** Where the 401 WWW-Authenticate header points the client for Protected Resource Metadata (RFC 9728). */
export function protectedResourceMetadataUrl(): string {
  return `${origin()}/.well-known/oauth-protected-resource/mcp/drive`;
}

export const SCOPES = ["mcp"] as const;
export const CODE_TTL_SEC = 120;
export const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 180;

/** Emails permitted to use the Drive MCP (defaults to JP/Shoyab/Fida — same finance team). */
export function allowedEmails(): string[] {
  const env = envVar("DRIVE_MCP_ALLOWED_EMAILS");
  const list = env ? env.split(",") : ["jp@innovfix.in", "shoyab@innovfix.in", "fida@innovfix.in"];
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export function isMcpAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
