/**
 * RFC 8414 Authorization Server Metadata for the TDS Working resource. Reached via rewrites from
 * /.well-known/oauth-authorization-server/mcp/tds-working (RFC 8414 path-insertion) and
 * /mcp/tds-working/.well-known/oauth-authorization-server (path-suffix) — see next.config.ts.
 */
import { authorizationServerMetadata } from "@/mcp/tds-working/oauth/metadata";
import { corsJson, preflight } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return corsJson(authorizationServerMetadata());
}
export async function OPTIONS(): Promise<Response> {
  return preflight();
}
