/**
 * Dynamic Client Registration endpoint (RFC 7591) for the Google Drive resource. DCR is
 * resource-agnostic (the client_id just encodes the client's redirect_uris), so this reuses the
 * shared, stateless client + CORS helpers. Public PKCE clients only. Returns 201 with a client_id.
 */
import { registerClient, isValidRedirectUri } from "@/mcp/onlycare-tds/oauth/clients";
import { corsJson, preflight, oauthError } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const redirect_uris = body?.redirect_uris;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every(isValidRedirectUri)) {
    return oauthError("invalid_client_metadata", "redirect_uris must be a non-empty array of https (or loopback http) URIs");
  }
  const client_name = typeof body?.client_name === "string" ? body.client_name : undefined;
  const client_id = registerClient({ redirect_uris, client_name });

  return corsJson(
    {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(client_name ? { client_name } : {}),
      scope: typeof body?.scope === "string" ? body.scope : "mcp",
    },
    201,
  );
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
