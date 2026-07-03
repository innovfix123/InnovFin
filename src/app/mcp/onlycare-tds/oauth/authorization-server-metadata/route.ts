/**
 * RFC 8414 Authorization Server Metadata. Reached via a rewrite from
 * /.well-known/oauth-authorization-server (and /.well-known/openid-configuration) — see next.config.ts.
 */
import { authorizationServerMetadata } from "@/mcp/onlycare-tds/oauth/metadata";
import { corsJson, preflight } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return corsJson(authorizationServerMetadata());
}
export async function OPTIONS(): Promise<Response> {
  return preflight();
}
