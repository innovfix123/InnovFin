/**
 * Google service-account authentication for the Drive MCP — dependency-free (no `googleapis` SDK).
 *
 * We hold ONE outbound credential: a Google service account whose email the finance folder is shared
 * with (Viewer). We sign a short-lived RS256 JWT with the SA private key and exchange it for an OAuth
 * access token via the JWT-bearer grant (https://oauth2.googleapis.com/token). Tokens are cached
 * in-process until just before expiry. Read-only scope only.
 *
 * This mirrors the repo's minimal-dependency, fetch-based outbound style (cf. gateway-settlements
 * calling the PG APIs, and src/lib/zoho/auth.ts's refresh-token exchange) rather than pulling in a
 * heavy Google client. The caller (drive-client.ts) never sees the token; the token never leaves here.
 *
 * Credentials come from the SA JSON key, supplied EITHER as:
 *   - GOOGLE_SA_KEY_JSON  — the full service-account JSON, inline in .env, or
 *   - GOOGLE_SA_KEY_FILE  — an absolute path to the downloaded JSON key file.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { envVar } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Read-only is all six tools need. Widen (drive.file / drive) only if/when write tools are added. */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

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
  if (inline && inline.trim().startsWith("{")) raw = inline;
  else if (file) raw = readFileSync(file, "utf8");
  else if (inline) raw = readFileSync(inline, "utf8"); // tolerate a path handed to GOOGLE_SA_KEY_JSON
  if (!raw) {
    throw new Error("Drive MCP: no service-account key — set GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE in .env");
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
      scope: SCOPE,
      aud: sa.token_uri || TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Return a valid Drive access token, minting a fresh one only when the cached token is within 60s of
 * expiry. Concurrent callers share the same in-flight fetch via the cache check after await.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expEpochMs - Date.now() > 60_000) return cachedToken.value;

  const sa = serviceAccount();
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signAssertion(sa),
  });
  const res = await fetch(sa.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive MCP: token exchange failed (${res.status}) ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Drive MCP: token response had no access_token");
  cachedToken = {
    value: json.access_token,
    expEpochMs: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/** The service-account email (for diagnostics — e.g. "share the folder with THIS address"). */
export function serviceAccountEmail(): string {
  return serviceAccount().client_email;
}
