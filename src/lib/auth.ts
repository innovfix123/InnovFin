import { createHmac, createHash, timingSafeEqual } from "crypto";

/**
 * Tiny self-contained login gate (no auth library, no DB).
 *
 * Access is limited to a fixed allow-list of Innovfix team emails, all sharing one
 * password (env `AUTH_PASSWORD`). A successful login mints an HMAC-signed cookie token
 * (signed with env `AUTH_SECRET`) carrying the email + an expiry — so it can't be forged.
 *
 * This module is pure (Node `crypto` only, no `next/headers`) so it is safe to import from
 * `proxy.ts` (which runs on the Node.js runtime) as well as from route handlers. Cookie
 * read/write lives in `session.ts`.
 */

export const ALLOWED_EMAILS = [
  "shoyab@innovfix.in",
  "fida@innovfix.in",
  "jp@innovfix.in",
  "ayush@innovfix.in",
  "satyam@innovfix.in",
  "krish@innovfix.in",
] as const;

export const SESSION_COOKIE = "if_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

function secret(): string {
  return process.env.AUTH_SECRET ?? "";
}

export function isAllowedEmail(email: string): boolean {
  return (ALLOWED_EMAILS as readonly string[]).includes(email);
}

/** Constant-time password check against `AUTH_PASSWORD` (hash both sides so length never leaks). */
export function checkPassword(input: string): boolean {
  const expected = process.env.AUTH_PASSWORD ?? "";
  if (!expected) return false; // fail closed when not configured
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Sign a session token: `base64url(payload).base64url(hmac)` where payload = `email:expiryMs`. */
export function signToken(email: string, ttlSec: number = SESSION_MAX_AGE): string {
  const payload = `${email}:${Date.now() + ttlSec * 1000}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** Verify a token → the email if the signature is valid, unexpired, and allow-listed; else null. */
export function verifyToken(token: string | undefined | null): string | null {
  if (!token || !secret()) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;

  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  if (!safeEqual(token.slice(dot + 1), expected)) return null;

  const sep = payload.lastIndexOf(":");
  if (sep < 0) return null;
  const email = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  if (!isAllowedEmail(email)) return null;
  return email;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
