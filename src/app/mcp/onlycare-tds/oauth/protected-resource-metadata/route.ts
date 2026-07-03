/**
 * RFC 9728 Protected Resource Metadata. Reached via a rewrite from
 * /.well-known/oauth-protected-resource[/mcp/onlycare-tds] — see next.config.ts.
 */
import { protectedResourceMetadata } from "@/mcp/onlycare-tds/oauth/metadata";
import { corsJson, preflight } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return corsJson(protectedResourceMetadata());
}
export async function OPTIONS(): Promise<Response> {
  return preflight();
}
