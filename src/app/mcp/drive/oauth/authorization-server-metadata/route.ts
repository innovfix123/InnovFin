/**
 * RFC 8414 Authorization Server Metadata for the Google Drive resource. Reached via rewrites from
 * /.well-known/oauth-authorization-server/mcp/drive (RFC 8414 path-insertion) and
 * /mcp/drive/.well-known/oauth-authorization-server (path-suffix) — see next.config.ts.
 */
import { authorizationServerMetadata } from "@/mcp/drive/oauth/metadata";
import { corsJson, preflight } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return corsJson(authorizationServerMetadata());
}
export async function OPTIONS(): Promise<Response> {
  return preflight();
}
