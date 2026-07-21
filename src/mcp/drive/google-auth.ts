/**
 * Google outbound authentication for the Drive tools — dependency-free (no `googleapis` SDK).
 *
 * TWO credential modes, tried in this order:
 *
 *  1. USER OAUTH (preferred, and the mode we actually run on) — a long-lived refresh token for the
 *     Google account that OWNS the folder, exchanged for access tokens via the refresh_token grant.
 *     Needed because the Cloud org enforces `iam.disableServiceAccountKeyCreation`, so no SA JSON key
 *     can be downloaded at all. It is also strictly better for writes: files are created as the real
 *     user, so there is no service-account storage-quota problem.
 *       GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 *     Mint the refresh token with: npm run drive:auth  (src/mcp/drive/oauth-setup.ts)
 *
 *  2. SERVICE ACCOUNT (fallback) — sign a short-lived RS256 JWT with the SA private key and exchange
 *     it via the JWT-bearer grant. Kept working for any environment where key creation IS allowed.
 *       GOOGLE_SA_KEY_JSON (inline JSON) or GOOGLE_SA_KEY_FILE (path to the downloaded key)
 *
 * Either way access tokens are cached in-process until just before expiry, the scope is read-only
 * unless DRIVE_MCP_WRITE is on, and the token never leaves this module — drive-client.ts only ever
 * receives the header. Mirrors the repo's minimal-dependency, fetch-based outbound style (cf.
 * gateway-settlements calling the PG APIs, and src/lib/zoho/auth.ts's refresh-token exchange).
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { envVar, writeEnabled } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const READWRITE_SCOPE = "https://www.googleapis.com/auth/drive";
/**
 * Read-only by default (all read tools need only this). The full `drive` scope is requested ONLY when
 * DRIVE_MCP_WRITE is enabled — so an SA shared as Viewer + flag-off endpoint can never mutate anything.
 * The folder must be shared with the SA as **Editor** for write tools to actually succeed.
 */
export function scope(): string {
  return writeEnabled() ? READWRITE_SCOPE : READONLY_SCOPE;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedSA: ServiceAccount | null = null;
let cachedToken: { value: string; expEpochMs: number } | null = null;

/** Load + validate the service-account JSON from GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE. */
function serviceAccount(): ServiceAccount {
  if (cachedSA) return cachedSA;
  const inline = envVar("GOOGLE_SA_KEY_JSON");
  const file = envVar("GOOGLE_SA_KEY_FILE");
  let raw: string | undefined;
  /** Read a key file, but fail with the reason a human needs rather than a bare ENOENT. */
  const readKeyFile = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(
        `Drive: service-account key file not readable at ${path} (${e instanceof Error ? e.message : e}). ` +
          "Note the Cloud org may block SA key creation entirely — prefer user OAuth: run `npm run drive:auth`.",
      );
    }
  };
  if (inline && inline.trim().startsWith("{")) raw = inline;
  else if (file) raw = readKeyFile(file);
  else if (inline) raw = readKeyFile(inline); // tolerate a path handed to GOOGLE_SA_KEY_JSON
  if (!raw) {
    throw new Error(
      "Drive: no Google credential — either run `npm run drive:auth` to set GOOGLE_OAUTH_* (preferred), " +
        "or set GOOGLE_SA_KEY_JSON / GOOGLE_SA_KEY_FILE for service-account auth",
    );
  }
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("Drive MCP: GOOGLE_SA_KEY_JSON is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Drive MCP: service-account JSON missing client_email/private_key");
  }
  // .env single-line values escape newlines; PEM needs real ones.
  sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  cachedSA = sa;
  return sa;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Build + RS256-sign the JWT assertion for the JWT-bearer grant. */
function signAssertion(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scope(),
      aud: sa.token_uri || TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/** The user-OAuth credential triple, when configured (mode 1). */
export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * User-OAuth credentials, or null when not configured (→ fall back to the service account).
 * All three parts must be present; a partial set is a misconfiguration worth failing loudly on.
 */
export function oauthCreds(): OAuthCreds | null {
  const clientId = envVar("GOOGLE_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = envVar("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
  const refreshToken = envVar("GOOGLE_OAUTH_REFRESH_TOKEN")?.trim();
  if (!clientId && !clientSecret && !refreshToken) return null;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Drive: partial Google OAuth config — GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and " +
        "GOOGLE_OAUTH_REFRESH_TOKEN must all be set (run `npm run drive:auth` to mint the refresh token)",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

/** Which credential mode is active — surfaced in diagnostics and the startup log. */
export function credentialMode(): "user-oauth" | "service-account" {
  return oauthCreds() ? "user-oauth" : "service-account";
}

/** POST the token endpoint and cache the returned access token. Shared by both modes. */
async function exchange(url: string, body: URLSearchParams, what: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive: ${what} token exchange failed (${res.status}) ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error(`Drive: ${what} token response had no access_token`);
  cachedToken = { value: json.access_token, expEpochMs: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Return a valid Drive access token, minting a fresh one only when the cached token is within 60s of
 * expiry. Uses the user-OAuth refresh token when configured, else the service-account JWT-bearer grant.
 *
 * Note the granted scope for user OAuth is fixed at consent time (see oauth-setup.ts), not per request;
 * DRIVE_MCP_WRITE still gates which tools exist, so a read-only consent plus flag-off stays read-only.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expEpochMs - Date.now() > 60_000) return cachedToken.value;

  const oauth = oauthCreds();
  if (oauth) {
    return exchange(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
      }),
      "user-oauth",
    );
  }

  const sa = serviceAccount();
  return exchange(
    sa.token_uri || TOKEN_URL,
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(sa),
    }),
    "service-account",
  );
}

/** The service-account email (for diagnostics — e.g. "share the folder with THIS address"). */
export function serviceAccountEmail(): string {
  return serviceAccount().client_email;
}
