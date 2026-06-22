"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shows the signed-in email + a "Sign out" button. If `email` is passed (server component knows
 * it), it's used directly; otherwise the component fetches `/api/me` itself (for client pages).
 */
export function SignOutButton({ email: emailProp }: { email?: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(emailProp ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (emailProp !== undefined) return; // parent supplied it
    let alive = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setEmail(d.email); })
      .catch(() => {});
    return () => { alive = false; };
  }, [emailProp]);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* ignore — redirect to login regardless */
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {email && (
        <span className="hidden max-w-[12rem] truncate text-xs font-medium text-zinc-500 sm:inline" title={email}>
          {email}
        </span>
      )}
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-60"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
