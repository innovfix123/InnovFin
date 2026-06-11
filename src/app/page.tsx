import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">InnovFin</h1>
      <p className="mt-2 text-zinc-600">
        Automated Finance &amp; Compliance Operations — Innovfix Private Limited.
      </p>

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wide text-zinc-500">GST module</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Link
          href="/gst"
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow"
        >
          <h3 className="font-semibold text-zinc-900">GST Filing →</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Monthly run: auto-fetch sales → reconcile purchases &amp; RCM → final GSTR-3B report and challan.
          </p>
        </Link>
        <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-zinc-400">
          <h3 className="font-semibold">Compliance calendar</h3>
          <p className="mt-1 text-sm">Coming later — deadlines, reminders, filing status.</p>
        </div>
      </div>
    </main>
  );
}
