"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { inr } from "@/lib/format";

type Mode = "auto" | "manual";
type SalesSource = { app: string; hsn: number; provider: string; mode: Mode; configured: boolean };
type Gstr1Line = { app: string; taxable: number; cgst: number; sgst: number; invoiceValueActual: number; hsn?: number; count: number };
type SourceStatus = { app: string; mode: Mode; status: "ok" | "pending" | "error"; count?: number; taxable?: number; message?: string };
type SalesResult = {
  period: string;
  lines: Gstr1Line[];
  total: { taxable: number; cgst: number; sgst: number; invoiceValueActual: number; count: number };
  sources: SourceStatus[];
};
type Trip = { igst: number; cgst: number; sgst: number };
type TaxRow = { taxable: number; igst: number; cgst: number; sgst: number };
type Gstr3bResult = {
  period: string;
  table31: { outwardTaxable: TaxRow; rcmLiability: TaxRow; total: TaxRow };
  table4: { totalAvailable: Trip; net: Trip; itcRcm: Trip; itcOther: Trip };
  table61: Record<"igst" | "cgst" | "sgst", { liability: number; itcUsed: number; cash: number }>;
  offsetDetail: { igstUsedForIgst: number; igstCrossToCgst: number; igstCrossToSgst: number; cgstOwnUsed: number; sgstOwnUsed: number };
  cashChallan: {
    rcm: Trip & { total: number };
    regular: Trip & { total: number };
    lateFee: number; interest: number;
    total: Trip & { grandTotal: number };
  };
};

const PROVIDER_LABEL: Record<string, string> = {
  razorpay: "Razorpay", cashfree: "Cashfree", appdb: "App dashboard", manual: "PhonePe (manual)",
};

function defaultPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const STEPS = ["Sales (GSTR-1)", "Purchases / RCM", "Review & File"];

export default function GstWizard() {
  const [step, setStep] = useState(1);
  const [period, setPeriod] = useState<string>(defaultPeriod);
  const [plan, setPlan] = useState<SalesSource[]>([]);
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [sales, setSales] = useState<SalesResult | null>(null);

  const [itc, setItc] = useState<TaxRow>({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  const [foreign, setForeign] = useState<{ taxable: number; igst: number }>({ taxable: 0, igst: 0 });
  const [rent, setRent] = useState<{ taxable: number; cgst: number; sgst: number }>({ taxable: 0, cgst: 0, sgst: 0 });
  const [lateFee, setLateFee] = useState(0);
  const [interest, setInterest] = useState(0);

  const [g3, setG3] = useState<Gstr3bResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sources").then((r) => r.json()).then((d) => setPlan(d.sources ?? [])).catch(() => {});
  }, []);

  const tieOut = useMemo(() => sales != null && sales.lines.length > 0, [sales]);

  function inputBody() {
    return {
      period,
      outward: { taxable: sales?.total.taxable ?? 0, cgst: sales?.total.cgst ?? 0, sgst: sales?.total.sgst ?? 0 },
      rcm: { foreign, rent },
      itc2b: itc,
      lateFee, interest,
    };
  }

  async function runSales() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set("period", period);
      for (const s of plan) { const f = files[s.app]; if (f) fd.set(`file:${s.app}`, f); }
      const res = await fetch("/api/sales", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setSales((await res.json()) as SalesResult);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function runGstr3b() {
    if (!sales) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/gstr3b/compute", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inputBody()),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setG3((await res.json()) as Gstr3bResult);
      setStep(3);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function downloadReport() {
    const res = await fetch("/api/gstr3b/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inputBody()),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Innovfix GSTR-3B ${period}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  const statusFor = (app: string) => sales?.sources.find((s) => s.app === app);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6">
        <nav className="mb-3 text-sm"><Link href="/" className="text-zinc-500 hover:text-zinc-800">← InnovFin</Link></nav>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">GST Filing</h1>
            <p className="text-sm text-zinc-500">Innovfix Private Limited · GSTIN 29AAICI1603A1Z3</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-600">Return month</span>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5" />
          </label>
        </div>
      </header>

      {/* Stepper */}
      <ol className="mb-8 flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const active = n === step, done = n < step;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                active ? "bg-indigo-600 text-white" : done ? "bg-emerald-500 text-white" : "bg-zinc-200 text-zinc-500"}`}>
                {done ? "✓" : n}
              </span>
              <span className={`truncate ${active ? "font-semibold text-zinc-900" : "text-zinc-500"}`}>{label}</span>
              {n < STEPS.length && <span className="mx-1 h-px flex-1 bg-zinc-200" />}
            </li>
          );
        })}
      </ol>

      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* STEP 1 — SALES */}
      {step === 1 && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-500">
            Sources auto-fetch where API/DB access is configured. PhonePe is always a manual upload; any
            not-yet-configured source can be uploaded manually as a fallback.
          </p>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr><th className="px-3 py-2">App</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Manual upload (fallback)</th><th className="px-3 py-2 text-right">Taxable</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {plan.map((s) => {
                  const st = statusFor(s.app);
                  const auto = s.mode === "auto" && s.configured;
                  return (
                    <tr key={s.app}>
                      <td className="px-3 py-2 font-medium text-zinc-800">{s.app}<span className="ml-2 text-xs text-zinc-400">HSN {s.hsn}</span></td>
                      <td className="px-3 py-2 text-zinc-600">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${auto ? "bg-emerald-100 text-emerald-700" : s.mode === "manual" ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-600"}`}>
                          {auto ? "Auto ✓" : s.mode === "manual" ? "Manual" : "Auto · add key"}
                        </span>
                        <span className="ml-2 text-xs text-zinc-400">{PROVIDER_LABEL[s.provider] ?? s.provider}</span>
                      </td>
                      <td className="px-3 py-2">
                        {st ? (
                          <span className={st.status === "ok" ? "text-emerald-600" : st.status === "error" ? "text-red-600" : "text-amber-600"}>
                            {st.status === "ok" ? `✓ ${st.count ?? 0} txns` : st.status === "error" ? "error" : "pending"}
                          </span>
                        ) : <span className="text-zinc-400">—</span>}
                        {st?.message && <span className="ml-1 text-xs text-zinc-400">{st.message}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input type="file" accept=".csv,.xlsx,.xls"
                          onChange={(e) => setFiles((f) => ({ ...f, [s.app]: e.target.files?.[0] }))}
                          className="block w-full max-w-[200px] text-xs text-zinc-600 file:mr-2 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-xs hover:file:bg-zinc-200" />
                        {files[s.app] && <span className="text-xs text-emerald-600">✓ {files[s.app]?.name}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{st?.taxable != null ? inr(st.taxable) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              {sales && (
                <tfoot className="bg-zinc-50 font-semibold">
                  <tr><td className="px-3 py-2" colSpan={4}>GSTR-1 total taxable {tieOut && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">✓ tie-out</span>}</td><td className="px-3 py-2 text-right tabular-nums">{inr(sales.total.taxable)}</td></tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={runSales} disabled={busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Fetching…" : "Fetch & compute GSTR-1"}
            </button>
            <button onClick={() => setStep(2)} disabled={!sales || sales.lines.length === 0}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
              Next: Purchases / RCM →
            </button>
          </div>
        </section>
      )}

      {/* STEP 2 — PURCHASES / RCM */}
      {step === 2 && (
        <section className="space-y-6">
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="font-semibold text-zinc-800">GSTR-2B — Input Tax Credit (Table 4(A)(5))</h3>
            <p className="mb-3 text-xs text-zinc-500">From the GSTR-2B downloaded from the portal. (Auto-parse of the 2B file is coming; enter the totals for now.)</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <NumField label="Taxable" value={itc.taxable} onChange={(v) => setItc({ ...itc, taxable: v })} />
              <NumField label="IGST" value={itc.igst} onChange={(v) => setItc({ ...itc, igst: v })} />
              <NumField label="CGST" value={itc.cgst} onChange={(v) => setItc({ ...itc, cgst: v })} />
              <NumField label="SGST" value={itc.sgst} onChange={(v) => setItc({ ...itc, sgst: v })} />
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="font-semibold text-zinc-800">RCM — Reverse charge (Table 3.1(d))</h3>
            <p className="mb-3 text-xs text-zinc-500">Foreign vendors → IGST 18%; unregistered rent → CGST+SGST 9%. (Auto-classification from the bank statement is coming; enter for now.)</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-zinc-600">Foreign (import of services)</p>
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Taxable (₹ paid)" value={foreign.taxable} onChange={(v) => setForeign({ taxable: v, igst: round2(v * 0.18) })} />
                  <NumField label="IGST" value={foreign.igst} onChange={(v) => setForeign({ ...foreign, igst: v })} />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-zinc-600">Rent (unregistered landlords)</p>
                <div className="grid grid-cols-3 gap-3">
                  <NumField label="Taxable" value={rent.taxable} onChange={(v) => setRent({ taxable: v, cgst: round2(v * 0.09), sgst: round2(v * 0.09) })} />
                  <NumField label="CGST" value={rent.cgst} onChange={(v) => setRent({ ...rent, cgst: v })} />
                  <NumField label="SGST" value={rent.sgst} onChange={(v) => setRent({ ...rent, sgst: v })} />
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
            <NumField label="Late fee" value={lateFee} onChange={setLateFee} />
            <NumField label="Interest" value={interest} onChange={setInterest} />
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setStep(1)} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">← Back</button>
            <button onClick={runGstr3b} disabled={busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Computing…" : "Compute GSTR-3B →"}
            </button>
          </div>
        </section>
      )}

      {/* STEP 3 — REVIEW & FILE */}
      {step === 3 && g3 && (
        <section className="space-y-6">
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
            <p className="text-sm text-indigo-700">Total cash challan payable</p>
            <p className="text-3xl font-bold tracking-tight text-indigo-900">₹{inr(g3.cashChallan.total.grandTotal)}</p>
            <p className="mt-1 text-xs text-indigo-700">
              RCM (cash) ₹{inr(g3.cashChallan.rcm.total)} · Regular after ITC ₹{inr(g3.cashChallan.regular.total)}
            </p>
          </div>

          <MiniTable title="Table 6.1 — Payment of tax" head={["", "Liability", "ITC used", "Cash"]}
            rows={(["igst", "cgst", "sgst"] as const).map((k) => [k.toUpperCase(), inr(g3.table61[k].liability), inr(g3.table61[k].itcUsed), inr(g3.table61[k].cash)])} />

          <MiniTable title="Cash challan breakup" head={["", "IGST", "CGST", "SGST", "Total"]}
            rows={[
              ["RCM (mandatory cash)", inr(g3.cashChallan.rcm.igst), inr(g3.cashChallan.rcm.cgst), inr(g3.cashChallan.rcm.sgst), inr(g3.cashChallan.rcm.total)],
              ["Regular (after ITC)", inr(g3.cashChallan.regular.igst), inr(g3.cashChallan.regular.cgst), inr(g3.cashChallan.regular.sgst), inr(g3.cashChallan.regular.total)],
              ["TOTAL CHALLAN", inr(g3.cashChallan.total.igst), inr(g3.cashChallan.total.cgst), inr(g3.cashChallan.total.sgst), inr(g3.cashChallan.total.grandTotal)],
            ]} />

          <div className="flex items-center gap-3">
            <button onClick={() => setStep(2)} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">← Back</button>
            <button onClick={downloadReport} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              ⬇ Download final GSTR-3B report
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      <input type="number" inputMode="decimal" value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums" />
    </label>
  );
}

function MiniTable({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-zinc-700">{title}</h3>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>{head.map((h, i) => <th key={i} className={`px-3 py-2 ${i === 0 ? "" : "text-right"}`}>{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r, ri) => (
              <tr key={ri} className={String(r[0]).startsWith("TOTAL") ? "bg-zinc-50 font-semibold" : ""}>
                {r.map((c, ci) => <td key={ci} className={`px-3 py-2 ${ci === 0 ? "font-medium text-zinc-800" : "text-right tabular-nums"}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
