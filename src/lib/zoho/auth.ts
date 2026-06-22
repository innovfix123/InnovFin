/**
 * Zoho OAuth 2.0 — exchanges the long-lived refresh token for a 1-hour access token.
 *
 * Verified against Zoho's docs: POST {accountsBase}/oauth/v2/token with the four
 * params in the QUERY STRING (not a JSON body); the access token goes back in the
 * `Authorization: Zoho-oauthtoken <token>` header on every API call (see client.ts).
 *
 * The token is cached in-process and refreshed ~2 minutes before expiry. Concurrent
 * callers share a single in-flight refresh (no stampede) — important under the
 * 100-req/min limit, where wasting calls on redundant refreshes hurts.
 */
import { getZohoConfig, type ZohoConfig } from "./config";
import type { ZohoTokenResponse } from "./types";

export interface ZohoAuthOptions {
  config?: ZohoConfig;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface ZohoAuth {
  /** Returns a valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;
  /** Clears the cached token (e.g. after a 401). */
  reset(): void;
}

/** Refresh this many ms before the real expiry, to avoid using a token that dies mid-flight. */
const EARLY_REFRESH_MS = 120_000;

export function createZohoAuth(opts: ZohoAuthOptions = {}): ZohoAuth {
  const cfg = opts.config ?? getZohoConfig();
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  let token: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const url = new URL(`${cfg.accountsBase}/oauth/v2/token`);
    url.searchParams.set("refresh_token", cfg.refreshToken);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("client_secret", cfg.clientSecret);
    url.searchParams.set("grant_type", "refresh_token");

    const res = await doFetch(url.toString(), { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as ZohoTokenResponse;
    if (!res.ok || data.error || !data.access_token) {
      throw new Error(`Zoho token refresh failed: ${data.error ?? `HTTP ${res.status}`}`);
    }
    token = data.access_token;
    expiresAt = now() + (data.expires_in ?? 3600) * 1000;
    return token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (token && expiresAt - EARLY_REFRESH_MS > now()) return token;
      if (inFlight) return inFlight;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    reset() {
      token = null;
      expiresAt = 0;
    },
  };
}
