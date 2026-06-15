import Link from "next/link";
import type { ReactNode } from "react";

type Status = "live" | "soon" | "planned";

type Automation = {
  title: string;
  description: string;
  href?: string;
  status: Status;
  icon: ReactNode;
};

const AUTOMATIONS: Automation[] = [
  {
    title: "GST Filing",
    description:
      "Monthly run: auto-fetch sales → reconcile purchases & RCM → final GSTR-3B report and challan.",
    href: "/gst",
    status: "live",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v5h5" />
        <path d="m9 14 2 2 4-4" />
      </svg>
    ),
  },
  {
    title: "Compliance calendar",
    description: "Deadlines, reminders and filing status across every return — never miss a due date.",
    status: "soon",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
        <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      </svg>
    ),
  },
  {
    title: "TDS & TCS",
    description: "Compute, reconcile against 26AS and prepare quarterly returns and challans.",
    status: "planned",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 5 5 19" />
        <circle cx="6.75" cy="6.75" r="2.25" />
        <circle cx="17.25" cy="17.25" r="2.25" />
      </svg>
    ),
  },
  {
    title: "Bank reconciliation",
    description: "Match statements to the ledger automatically and surface only the breaks that need a human.",
    status: "planned",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 3.5 21 7.5l-4 4" />
        <path d="M21 7.5H7a4 4 0 0 0-4 4" />
        <path d="M7 20.5 3 16.5l4-4" />
        <path d="M3 16.5h14a4 4 0 0 0 4-4" />
      </svg>
    ),
  },
];

const STATUS_BADGE: Record<Status, { label: string; dot: string; text: string }> = {
  live: { label: "Live", dot: "bg-emerald-500", text: "text-emerald-700" },
  soon: { label: "Coming soon", dot: "bg-amber-400", text: "text-amber-600" },
  planned: { label: "Planned", dot: "bg-zinc-300", text: "text-zinc-400" },
};

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[55%] w-[55%]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </svg>
    </span>
  );
}

function AutomationCard({ a, index }: { a: Automation; index: number }) {
  const badge = STATUS_BADGE[a.status];
  const live = a.status === "live";
  const style = { animationDelay: `${320 + index * 90}ms` };

  const body = (
    <>
      <div className="flex items-start justify-between">
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105 ${
            live ? "bg-indigo-50 text-indigo-600" : "bg-zinc-100 text-zinc-400"
          }`}
        >
          <span className="h-6 w-6">{a.icon}</span>
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${badge.text}`}>
          {live ? (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${badge.dot}`} />
            </span>
          ) : (
            <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          )}
          {badge.label}
        </span>
      </div>
      <h3 className={`mt-4 flex items-center gap-1 text-base font-semibold ${live ? "text-zinc-900" : "text-zinc-500"}`}>
        {a.title}
        {live && <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>}
      </h3>
      <p className={`mt-1.5 text-sm leading-relaxed ${live ? "text-zinc-500" : "text-zinc-400"}`}>{a.description}</p>
    </>
  );

  const base = "if-reveal rounded-2xl border p-5";
  if (a.href) {
    return (
      <Link
        href={a.href}
        style={style}
        className={`group ${base} border-zinc-200 bg-white shadow-sm transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-1 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100`}
      >
        {body}
      </Link>
    );
  }
  return <div style={style} className={`group ${base} border-zinc-200/80 bg-white/55`}>{body}</div>;
}

export default function Home() {
  const liveCount = AUTOMATIONS.filter((a) => a.status === "live").length;

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-white/60 bg-white/70 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="group flex items-center gap-2.5">
            <BrandMark className="h-9 w-9 transition-transform duration-300 group-hover:scale-105" />
            <span className="leading-tight">
              <span className="block text-sm font-bold tracking-tight text-zinc-900">InnovFin</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
                Automations
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden items-center gap-1.5 text-zinc-500 sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              All systems operational
            </span>
            <span className="rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs font-medium text-zinc-600">
              Innovfix Pvt Ltd
            </span>
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        <div aria-hidden className="if-float pointer-events-none absolute -top-28 right-[-6rem] -z-10 h-80 w-80 rounded-full bg-indigo-400/25 blur-3xl" />
        <div aria-hidden className="if-float-slow pointer-events-none absolute top-40 left-[-8rem] -z-10 h-72 w-72 rounded-full bg-violet-400/20 blur-3xl" />

        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <section className="max-w-2xl">
            <span className="if-reveal inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50/80 px-3 py-1 text-xs font-semibold text-indigo-700">
              Finance &amp; Compliance Automation Platform
            </span>
            <h1 className="if-reveal mt-5 text-4xl font-bold leading-[1.1] tracking-tight text-zinc-900 sm:text-5xl" style={{ animationDelay: "90ms" }}>
              Automations that run your back office.
            </h1>
            <p className="if-reveal mt-4 text-lg leading-relaxed text-zinc-600" style={{ animationDelay: "180ms" }}>
              InnovFin turns recurring finance and compliance work into one-click monthly runs —
              accurate, auditable and ready to file. Built for Innovfix Private Limited.
            </p>
          </section>

          <section className="mt-14">
            <div className="if-reveal flex items-end justify-between" style={{ animationDelay: "260ms" }}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Automations</h2>
              <span className="text-xs text-zinc-400">{liveCount} live · more on the way</span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {AUTOMATIONS.map((a, i) => (
                <AutomationCard key={a.title} a={a} index={i} />
              ))}
            </div>
          </section>
        </div>
      </main>

      <footer className="if-fade border-t border-white/60 bg-white/40" style={{ animationDelay: "700ms" }}>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-6 py-5 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="h-5 w-5" />
            InnovFin Automations · Innovfix Private Limited
          </span>
          <span className="tabular-nums text-zinc-400">GSTIN 29AAICI1603A1Z3</span>
        </div>
      </footer>
    </>
  );
}
