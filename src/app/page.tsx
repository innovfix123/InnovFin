import Link from "next/link";
import type { ReactNode } from "react";

type Status = "live" | "soon" | "planned";
type Accent = "indigo" | "amber" | "emerald" | "sky";

type Automation = {
  title: string;
  description: string;
  href?: string;
  status: Status;
  accent: Accent;
  featured?: boolean;
  cta?: string;
  icon: ReactNode;
};

const AUTOMATIONS: Automation[] = [
  {
    title: "GST Filing",
    accent: "indigo",
    featured: true,
    status: "live",
    href: "/gst",
    cta: "Open GST filing",
    description:
      "Auto-fetch sales, reconcile purchases & RCM, and produce a filing-ready GSTR-3B with the cash challan — in one monthly run.",
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
    accent: "amber",
    status: "soon",
    description: "Due dates, reminders and filing status across every return.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
        <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
      </svg>
    ),
  },
  {
    title: "TDS & TCS",
    accent: "emerald",
    status: "planned",
    description: "Compute, reconcile against 26AS and prepare quarterly returns.",
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
    accent: "sky",
    status: "planned",
    description: "Match statements to the ledger and surface only the breaks.",
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

const ACCENT_TILE: Record<Accent, string> = {
  indigo: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/25",
  amber: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/25",
  emerald: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/25",
  sky: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/25",
};

const STATUS_BADGE: Record<Status, { label: string; dot: string; text: string }> = {
  live: { label: "Live", dot: "bg-emerald-400", text: "text-emerald-400" },
  soon: { label: "Coming soon", dot: "bg-amber-400", text: "text-amber-400" },
  planned: { label: "Planned", dot: "bg-zinc-500", text: "text-zinc-500" },
};

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30 ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[55%] w-[55%]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </svg>
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const badge = STATUS_BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${badge.text}`}>
      {status === "live" ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${badge.dot}`} />
        </span>
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
      )}
      {badge.label}
    </span>
  );
}

function AutomationCard({ a, index }: { a: Automation; index: number }) {
  const style = { animationDelay: `${260 + index * 80}ms` };

  const content = (
    <>
      <div className="flex items-start justify-between">
        <span
          className={`flex items-center justify-center rounded-xl ${a.featured ? "h-12 w-12" : "h-10 w-10"} ${ACCENT_TILE[a.accent]}`}
        >
          <span className={a.featured ? "h-6 w-6" : "h-5 w-5"}>{a.icon}</span>
        </span>
        <StatusBadge status={a.status} />
      </div>
      <h3 className={`mt-4 font-semibold text-white ${a.featured ? "text-lg" : "text-[15px]"}`}>{a.title}</h3>
      <p className={`mt-1.5 leading-relaxed text-zinc-400 ${a.featured ? "text-sm" : "text-[13px]"}`}>{a.description}</p>
      {a.cta && (
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-300">
          {a.cta}
          <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>
        </span>
      )}
    </>
  );

  const span = a.featured ? "lg:col-span-2" : "";
  const base = `if-reveal flex flex-col rounded-2xl border p-5 ${span}`;

  if (a.href) {
    return (
      <Link
        href={a.href}
        style={style}
        className={`group ${base} border-indigo-500/25 bg-gradient-to-br from-indigo-500/[0.08] to-white/[0.01] transition-[border-color,box-shadow] duration-300 hover:border-indigo-400/60 hover:shadow-[0_0_45px_-12px_rgba(99,102,241,0.7)]`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div style={style} className={`${base} border-white/10 bg-white/[0.02]`}>
      {content}
    </div>
  );
}

export default function Home() {
  const liveCount = AUTOMATIONS.filter((a) => a.status === "live").length;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/60 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="group flex items-center gap-2.5">
            <BrandMark className="h-9 w-9 transition-transform duration-300 group-hover:scale-105" />
            <span className="leading-tight">
              <span className="block text-sm font-bold tracking-tight text-white">InnovFin</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-300/70">
                Automations
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden items-center gap-1.5 text-zinc-400 sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              All systems operational
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-zinc-300">
              Innovfix Pvt Ltd
            </span>
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        <div aria-hidden className="if-float pointer-events-none absolute -top-24 right-[-6rem] h-80 w-80 rounded-full bg-indigo-600/30 blur-[110px]" />
        <div aria-hidden className="if-float-slow pointer-events-none absolute top-56 left-[-9rem] h-72 w-72 rounded-full bg-violet-600/25 blur-[110px]" />
        <div aria-hidden className="if-float pointer-events-none absolute bottom-[-7rem] right-1/4 h-72 w-72 rounded-full bg-sky-500/15 blur-[120px]" />

        <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-16">
          <section className="max-w-2xl">
            <span className="if-reveal inline-flex items-center gap-1.5 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
              Finance &amp; Compliance Platform
            </span>
            <h1 className="if-reveal mt-4 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl" style={{ animationDelay: "80ms" }}>
              <span className="if-gradient-text inline-block pb-1">InnovFin Automations</span>
            </h1>
            <p className="if-reveal mt-3 max-w-lg text-sm leading-relaxed text-zinc-400" style={{ animationDelay: "150ms" }}>
              Your finance &amp; compliance, on autopilot. One-click monthly runs — accurate, auditable
              and ready to file.
            </p>
          </section>

          <section className="mt-12">
            <div className="if-reveal flex items-end justify-between" style={{ animationDelay: "210ms" }}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Automations</h2>
              <span className="text-xs text-zinc-600">{liveCount} live · more on the way</span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {AUTOMATIONS.map((a, i) => (
                <AutomationCard key={a.title} a={a} index={i} />
              ))}
              <div
                style={{ animationDelay: `${260 + AUTOMATIONS.length * 80}ms` }}
                className="if-reveal flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 p-5 text-center"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-white/15 text-zinc-500">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                <p className="mt-3 text-[13px] font-medium text-zinc-400">More automations</p>
                <p className="mt-0.5 text-[12px] text-zinc-600">More finance &amp; compliance runs are on the way.</p>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="if-fade border-t border-white/10" style={{ animationDelay: "600ms" }}>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-6 py-5 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="h-5 w-5" />
            InnovFin Automations · Innovfix Private Limited
          </span>
          <span className="tabular-nums text-zinc-600">GSTIN 29AAICI1603A1Z3</span>
        </div>
      </footer>
    </div>
  );
}
