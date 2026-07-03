/**
 * Dynamic Client Registration (RFC 7591), stateless.
 *
 * Claude self-registers as a public PKCE client. Rather than persist a client store (the DB is
 * read-only and we want zero restart-fragility), the client_id IS a signed token that encodes the
 * client's registered redirect_uris. At /authorize and /token we verify the signature and read the
 * redirect_uris straight back out — so a client_id can't be forged and needs no storage.
 */
import { signJwt, verifyJwt } from "./tokens";

const CLIENT_TTL_SEC = 60 * 60 * 24 * 365 * 5; // 5 years

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

/** https redirect URIs, or http on loopback (RFC 8252) for CLI clients. */
export function isValidRedirectUri(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Mint a stateless client_id encoding the registered redirect_uris. */
export function registerClient(meta: { redirect_uris: string[]; client_name?: string }): string {
  return signJwt("client", meta.client_name || "client", CLIENT_TTL_SEC, {
    ru: meta.redirect_uris,
    cn: meta.client_name ?? null,
  });
}

/** Verify a client_id and recover its registered redirect_uris, or null if invalid. */
export function parseClient(client_id: string | null | undefined): RegisteredClient | null {
  const c = verifyJwt(client_id, "client");
  if (!c) return null;
  const ru = Array.isArray(c.ru) ? (c.ru as unknown[]).filter(isValidRedirectUri) : [];
  if (!ru.length) return null;
  return { client_id: client_id as string, redirect_uris: ru, client_name: typeof c.cn === "string" ? c.cn : undefined };
}
