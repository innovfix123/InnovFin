/**
 * Token endpoint for the Hima resource. Mirror of Only Care's, off the HIMA config/grants so the
 * minted access token's audience = the Hima resource. Reuses the shared (resource-agnostic) JWT
 * verifier, PKCE check, and CORS helpers. Public clients only (no secret).
 */
import { verifyJwt } from "@/mcp/onlycare-tds/oauth/tokens";
import { verifyPkce } from "@/mcp/onlycare-tds/oauth/pkce";
import { issueTokens, claimCode } from "@/mcp/hima-tds/oauth/grants";
import { isMcpAllowed, resource } from "@/mcp/hima-tds/oauth/config";
import { corsJson, preflight, oauthError } from "@/mcp/onlycare-tds/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const claims = verifyJwt(code, "code");
    if (!claims) return oauthError("invalid_grant", "authorization code is invalid or expired");
    // Share the signing key with Only Care, so pin the code to THIS resource (reject a code minted
    // for a different resource that happens to verify under the same key).
    if (claims.aud !== resource()) return oauthError("invalid_grant", "authorization code was not issued for this resource");
    if (!verifier || !verifyPkce(verifier, String(claims.cc), "S256")) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    if (redirectUri && redirectUri !== claims.ru) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!claimCode(code as string)) return oauthError("invalid_grant", "authorization code already used");
    if (!isMcpAllowed(claims.sub)) return oauthError("access_denied", "user is not authorized", 403);
    return corsJson(issueTokens(claims.sub, String(claims.scope ?? "mcp")));
  }

  if (grantType === "refresh_token") {
    const claims = verifyJwt(form.get("refresh_token"), "refresh");
    if (!claims) return oauthError("invalid_grant", "refresh token is invalid or expired");
    if (claims.aud !== resource()) return oauthError("invalid_grant", "refresh token was not issued for this resource");
    if (!isMcpAllowed(claims.sub)) return oauthError("access_denied", "user is not authorized", 403);
    return corsJson(issueTokens(claims.sub, String(claims.scope ?? "mcp")));
  }

  return oauthError("unsupported_grant_type", "supported grants: authorization_code, refresh_token");
}

export async function OPTIONS(): Promise<Response> {
  return preflight();
}
