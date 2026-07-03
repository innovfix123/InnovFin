/**
 * Small Web-Response helpers for the OAuth endpoints. claude.ai fetches the discovery docs and
 * calls /register and /token from a browser/cloud context, so these need permissive CORS.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
} as const;

/** JSON response with CORS + no-store (OAuth responses must never be cached). */
export function corsJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  });
}

/** CORS preflight. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** RFC 6749 OAuth error object. */
export function oauthError(error: string, description: string, status = 400): Response {
  return corsJson({ error, error_description: description }, status);
}
