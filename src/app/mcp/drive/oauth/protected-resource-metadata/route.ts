/**
 * RFC 9728 Protected Resource Metadata for the Google Drive resource. Reached via a rewrite from
 * /.well-known/oauth-protected-resource[/mcp/drive] — see next.config.ts. Advertises the resource
 * identifier + its (path-based, co-located) authorization server.
 */
import { protectedResourceMetadata } from "@/mcp/drive/oauth/metadata";
import { corsJson, preflight } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return corsJson(protectedResourceMetadata());
}
export async function OPTIONS(): Promise<Response> {
  return preflight();
}
