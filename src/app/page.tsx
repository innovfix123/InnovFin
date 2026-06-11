import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">InnovFin</h1>
      <p className="mt-2 text-zinc-600">
        Automated Finance &amp; Compliance Operations — Innovfix Private Limited.
      </p>

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        GST module
      </h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Link
          href="/gstr1"
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow"
        >
          <h3 className="font-semibold text-zinc-900">GSTR-1 Working →</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Upload the 6 apps&apos; reports → per-app + HSN-wise B2C working, with tie-out and
            Excel export.
          </p>
        </Link>
        <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-zinc-400">
          <h3 className="font-semibold">GSTR-3B Working</h3>
          <p className="mt-1 text-sm">
            Coming next — 2B reconciliation, RCM, Rule 88A &amp; challan.
          </p>
        </div>
      </div>
    </main>
  );
}
