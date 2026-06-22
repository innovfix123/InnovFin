import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import { SiteFooter } from "@/components/site-footer";
import { getSessionEmail } from "@/lib/session";

type Status = "live" | "soon" | "planned";
type Accent = "teal" | "amber" | "emerald" | "cyan";

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
    accent: "teal",
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
    accent: "cyan",
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
  teal: "bg-teal-500/10 text-teal-700 ring-1 ring-inset ring-teal-600/20",
  amber: "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-600/20",
  emerald: "bg-emerald-500/10 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
  cyan: "bg-cyan-500/10 text-cyan-700 ring-1 ring-inset ring-cyan-600/20",
};

const STATUS_BADGE: Record<Status, { label: string; dot: string; text: string }> = {
  live: { label: "Live", dot: "bg-emerald-500", text: "text-emerald-600" },
  soon: { label: "Coming soon", dot: "bg-amber-500", text: "text-amber-600" },
  planned: { label: "Planned", dot: "bg-zinc-400", text: "text-zinc-500" },
};

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
  const style = { animationDelay: `${120 + index * 80}ms` };

  const content = (
    <>
      <div className="flex items-start justify-between">
        <span className={`flex items-center justify-center rounded-xl ${a.featured ? "h-12 w-12" : "h-10 w-10"} ${ACCENT_TILE[a.accent]}`}>
          <span className={a.featured ? "h-6 w-6" : "h-5 w-5"}>{a.icon}</span>
        </span>
        <StatusBadge status={a.status} />
      </div>
      <h3 className={`mt-4 font-semibold text-zinc-900 ${a.featured ? "text-lg" : "text-[15px]"}`}>{a.title}</h3>
      <p className={`mt-1.5 leading-relaxed text-zinc-600 ${a.featured ? "text-sm" : "text-[13px]"}`}>{a.description}</p>
      {a.cta && (
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-teal-700">
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
        className={`group ${base} border-teal-500/30 bg-gradient-to-br from-teal-500/[0.06] to-white shadow-sm transition-[border-color,box-shadow] duration-300 hover:border-teal-500/70 hover:shadow-[0_12px_40px_-12px_rgba(13,148,136,0.45)]`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div style={style} className={`${base} border-zinc-200 bg-white shadow-sm`}>
      {content}
    </div>
  );
}

/* A polished preview of the GSTR-3B output — gives the hero a "real product" feel. */
function PreviewCard() {
  const rows = [
    ["Outward tax liability", "₹62,40,000"],
    ["ITC available (2B)", "₹48,95,000"],
    ["RCM — reverse charge", "₹3,95,000"],
  ];
  return (
    <div className="if-reveal relative" style={{ animationDelay: "260ms" }}>
      <div aria-hidden className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-emerald-400/20 to-teal-400/10 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white/90 shadow-2xl shadow-emerald-900/10 backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-sm font-semibold text-zinc-800">GSTR-3B · April 2026</span>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Ready to file</span>
        </div>
        <div className="space-y-2.5 px-5 py-4">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between text-sm">
              <span className="text-zinc-500">{k}</span>
              <span className="font-medium tabular-nums text-zinc-700">{v}</span>
            </div>
          ))}
          <div className="!mt-4 flex items-end justify-between border-t border-dashed border-zinc-200 pt-3">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Total cash challan</span>
            <span className="text-2xl font-bold tabular-nums text-zinc-900">₹17,40,000</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-zinc-100 bg-emerald-50/60 px-5 py-2.5 text-xs font-medium text-emerald-700">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Reconciled to the rupee · GSTR-1 ↔ 3B tie-out passed
        </div>
      </div>
    </div>
  );
}

const STATS: { value: string; label: string }[] = [
  { value: "1-click", label: "monthly GST run" },
  { value: "4", label: "payment & data sources" },
  { value: "GSTR-1 → 3B", label: "end-to-end coverage" },
  { value: "to the ₹", label: "reconciled exactly" },
];

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Connect your sources", body: "Razorpay, Cashfree, app databases and PhonePe feed in automatically — no CSV wrangling, no manual exports." },
  { n: "02", title: "Auto-compute & reconcile", body: "GSTR-1 from sales, ITC from the 2B, RCM from bank statements — computed and cross-reconciled to the rupee." },
  { n: "03", title: "Review & file", body: "A filing-ready GSTR-3B with the exact cash challan. Download the working and file on the government portal." },
];

const CAPABILITIES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Accurate to the rupee",
    body: "Every figure is reconciled against source data and validated against real filings — no surprises at the portal.",
    icon: <path d="M20 6 9 17l-5-5" />,
  },
  {
    title: "Fully auditable",
    body: "Multi-sheet working exports mirror your accountant's format, line by line, so every number is traceable.",
    icon: <><path d="M14 3v5h5" /><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /></>,
  },
  {
    title: "Multi-source connectors",
    body: "Payment gateways, app databases and manual feeds unified into a single, consistent return.",
    icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  },
  {
    title: "Private & secure",
    body: "Runs on your own infrastructure. Access is restricted to your team behind a sign-in.",
    icon: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  },
];

export default async function Home() {
  const email = await getSessionEmail();
  const liveCount = AUTOMATIONS.filter((a) => a.status === "live").length;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="group flex items-center gap-2.5">
            <BrandMark className="h-9 w-9 transition-transform duration-300 group-hover:scale-105" />
            <span className="leading-tight">
              <span className="block text-sm font-bold tracking-tight text-zinc-900">InnovFin</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-600/80">Automations</span>
            </span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-zinc-600 md:flex">
            <a href="#automations" className="transition-colors hover:text-zinc-900">Automations</a>
            <a href="#how" className="transition-colors hover:text-zinc-900">How it works</a>
            <a href="#why" className="transition-colors hover:text-zinc-900">Why InnovFin</a>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden items-center gap-1.5 text-zinc-600 lg:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              All systems operational
            </span>
            <SignOutButton email={email} />
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        <div aria-hidden className="if-float pointer-events-none absolute -top-24 right-[-6rem] h-80 w-80 rounded-full bg-emerald-400/25 blur-[110px]" />
        <div aria-hidden className="if-float-slow pointer-events-none absolute top-56 left-[-9rem] h-72 w-72 rounded-full bg-teal-400/20 blur-[110px]" />
        <div aria-hidden className="if-float pointer-events-none absolute bottom-[-7rem] right-1/4 h-72 w-72 rounded-full bg-cyan-400/15 blur-[120px]" />

        {/* HERO */}
        <section className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-24">
          <div>
            <span className="if-reveal inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 text-xs font-semibold text-teal-700">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
              Finance &amp; Compliance Platform
            </span>
            <h1 className="if-reveal mt-5 text-4xl font-bold leading-[1.08] tracking-tight text-zinc-900 sm:text-5xl lg:text-[3.4rem]" style={{ animationDelay: "80ms" }}>
              Your finance ops,{" "}
              <span className="if-gradient-text inline-block pb-1">on autopilot</span>
            </h1>
            <p className="if-reveal mt-5 max-w-xl text-base leading-relaxed text-zinc-600" style={{ animationDelay: "150ms" }}>
              InnovFin runs your monthly compliance end-to-end — auto-fetch sales, reconcile
              purchases &amp; RCM, and produce a filing-ready GSTR-3B with the exact cash challan.
              Accurate, auditable, and ready to file.
            </p>
            <div className="if-reveal mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "220ms" }}>
              <Link
                href="/gst"
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500 hover:shadow-emerald-600/30"
              >
                Open GST filing
                <span aria-hidden>→</span>
              </Link>
              <a
                href="#how"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white/70 px-5 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-white"
              >
                See how it works
              </a>
            </div>
          </div>
          <PreviewCard />
        </section>

        {/* STAT STRIP */}
        <section className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-4">
          <div className="if-reveal grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-200 shadow-sm sm:grid-cols-4" style={{ animationDelay: "300ms" }}>
            {STATS.map((s) => (
              <div key={s.label} className="bg-white px-5 py-5 text-center">
                <p className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-xl font-bold text-transparent sm:text-2xl">{s.value}</p>
                <p className="mt-1 text-xs text-zinc-500">{s.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* AUTOMATIONS */}
        <section id="automations" className="relative z-10 mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-16">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-teal-600">Automations</h2>
              <p className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">What you can automate</p>
            </div>
            <span className="hidden text-xs text-zinc-400 sm:block">{liveCount} live · more on the way</span>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AUTOMATIONS.map((a, i) => (
              <AutomationCard key={a.title} a={a} index={i} />
            ))}
            <div className="if-reveal flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 p-5 text-center" style={{ animationDelay: `${120 + AUTOMATIONS.length * 80}ms` }}>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-zinc-400">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <p className="mt-3 text-[13px] font-medium text-zinc-600">More automations</p>
              <p className="mt-0.5 text-[12px] text-zinc-400">More finance &amp; compliance runs are on the way.</p>
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how" className="relative z-10 scroll-mt-20 border-y border-zinc-200 bg-white/60">
          <div className="mx-auto w-full max-w-6xl px-6 py-16">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-teal-600">How it works</h2>
            <p className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">From raw transactions to a filed return — in three steps</p>
            <div className="mt-8 grid gap-5 md:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n} className="relative rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <span className="text-sm font-bold tabular-nums text-teal-600/70">{s.n}</span>
                  <h3 className="mt-2 text-base font-semibold text-zinc-900">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* WHY / CAPABILITIES */}
        <section id="why" className="relative z-10 mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-16">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-teal-600">Why InnovFin</h2>
          <p className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">Built for finance teams that can&apos;t afford to be wrong</p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-500/10 text-teal-700 ring-1 ring-inset ring-teal-600/20">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    {c.icon}
                  </svg>
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold text-zinc-900">{c.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-600">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA BAND */}
        <section className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-20">
          <div className="relative overflow-hidden rounded-3xl border border-teal-500/30 bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-cyan-500/10 px-8 py-12 text-center shadow-sm">
            <div aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-emerald-400/20 blur-3xl" />
            <h2 className="relative text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl">Ready to run this month&apos;s GST?</h2>
            <p className="relative mx-auto mt-2 max-w-md text-sm text-zinc-600">
              Fetch, reconcile and produce a filing-ready GSTR-3B in a single pass.
            </p>
            <Link
              href="/gst"
              className="relative mt-6 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500"
            >
              Open GST filing
              <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
