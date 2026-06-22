import { cookies } from "next/headers";
import { SESSION_COOKIE, SESSION_MAX_AGE, signToken, verifyToken } from "@/lib/auth";

/** Server-side session helpers (cookie read/write via `next/headers`). Not for use in `proxy.ts`. */

export async function setSession(email: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, signToken(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionEmail(): Promise<string | null> {
  const store = await cookies();
  return verifyToken(store.get(SESSION_COOKIE)?.value);
}
