/**
 * Authorization endpoint for the invoice-intelligence resource (OAuth 2.1 authorization-code + PKCE).
 * Mirror of Hima's authorize route, off this config (so the code's audience = this resource).
 *
 * Identity reuses the portal login: no session cookie → bounce to /login with ?next back here; once
 * signed in, check the allowlist and issue a short-lived, PKCE-bound authorization code, then redirect
 * to the client's registered redirect_uri. JWT signer + client parser are the shared, resource-agnostic ones.
 */
import { getSessionEmail } from "@/lib/session";
import { parseClient } from "@/mcp/onlycare-tds/oauth/clients";
import { signJwt } from "@/mcp/onlycare-tds/oauth/tokens";
import { origin, resource, isMcpAllowed, CODE_TTL_SEC } from "@/mcp/invoice-intelligence/oauth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlError(message: string, status = 400): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Authorization error</title><body style="font-family:system-ui;padding:2rem;color:#b91c1c"><h1>Couldn't authorize</h1><p>${message}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectBack(redirectUri: string, params: Record<string, string>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const state = p.get("state") ?? undefined;

  // Validate the client + redirect_uri BEFORE trusting redirect_uri as an error sink (no open redirects).
  const client = parseClient(clientId);
  if (!client) return htmlError("Unknown or invalid client. Remove and re-add the connector.");
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return htmlError("The redirect_uri is not registered for this client.");
  }
  const back = (params: Record<string, string>) => redirectBack(redirectUri, state ? { ...params, state } : params);

  if (p.get("response_type") !== "code") return back({ error: "unsupported_response_type", error_description: "response_type must be code" });
  const codeChallenge = p.get("code_challenge");
  if (!codeChallenge || p.get("code_challenge_method") !== "S256") {
    return back({ error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required" });
  }

  // Identity: reuse the portal session; if absent, send them through the existing login screen.
  const email = await getSessionEmail();
  if (!email) {
    const login = new URL("/login", origin());
    login.searchParams.set("next", url.pathname + url.search);
    return Response.redirect(login.toString(), 302);
  }
  if (!isMcpAllowed(email)) {
    return back({ error: "access_denied", error_description: `${email} is not authorized for Invoice Intelligence. Ask an admin to add you.` });
  }

  const scope = p.get("scope") || "mcp";
  const code = signJwt("code", email, CODE_TTL_SEC, { cid: client.client_id, ru: redirectUri, cc: codeChallenge, scope, aud: resource() });
  return back({ code });
}
