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
type Check = { label: string; expected: number; actual: number; diff: number; ok: boolean };
type ReconReport = { checks: Check[]; ok: boolean };
type Gstr3bResult = {
  period: string;
  reconciliation?: { gstr1Vs3b: ReconReport; internal: ReconReport };
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
  const [rcmReview, setRcmReview] = useState<{ vendor: string; amount: number; category: string; reason: string }[]>([]);
  const [rcmNote, setRcmNote] = useState<string>("");
  const [itcInfo, setItcInfo] = useState<string>("");
  const [gstr2bFile, setGstr2bFile] = useState<File | null>(null);
  const [bankFile, setBankFile] = useState<File | null>(null);

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

  async function downloadGstr1() {
    if (!sales) return;
    const res = await fetch("/api/gstr1/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ period, lines: sales.lines, total: sales.total }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Innovfix GSTR-1 ${period}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadFullWorkbook() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set("period", period);
      fd.set("input", JSON.stringify(inputBody()));
      if (gstr2bFile) fd.set("gstr2b", gstr2bFile);
      if (bankFile) fd.set("bank", bankFile);
      const res = await fetch("/api/gstr/workbook", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Workbook build failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `Innovfix GST Working ${period}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function uploadGstr2b(file: File) {
    setBusy(true); setError(null); setGstr2bFile(file);
    try {
      const fd = new FormData(); fd.set("file", file);
      const res = await fetch("/api/gstr2b/parse", { method: "POST", body: fd });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `GSTR-2B parse failed (${res.status})`);
      setItc({ taxable: r.itcAvailable.taxable || 0, igst: r.itcAvailable.igst || 0, cgst: r.itcAvailable.cgst || 0, sgst: r.itcAvailable.sgst || 0 });
      setItcInfo(`Parsed ${r.invoiceCount} B2B invoices → Table 4(A)(5) ITC auto-filled.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function uploadBankRcm(file: File) {
    setBusy(true); setError(null); setRcmReview([]); setRcmNote(""); setBankFile(file);
    try {
      const fd = new FormData(); fd.set("file", file);
      const res = await fetch("/api/rcm/parse", { method: "POST", body: fd });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `RCM parse failed (${res.status})`);
      setForeign({ taxable: r.foreign.taxable || 0, igst: r.foreign.igst || 0 });
      setRent({ taxable: r.rent.taxable || 0, cgst: r.rent.cgst || 0, sgst: r.rent.sgst || 0 });
      setRcmReview(r.review || []);
      setRcmNote(r.note || "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function addReview(item: { vendor: string; amount: number; category: string; reason: string }) {
    if (item.category === "rent") setRent((r) => { const t = r.taxable + item.amount; return { taxable: t, cgst: round2(t * 0.09), sgst: round2(t * 0.09) }; });
    else setForeign((f) => { const t = f.taxable + item.amount; return { taxable: t, igst: round2(t * 0.18) }; });
    setRcmReview((rv) => rv.filter((x) => x !== item));
  }

  const statusFor = (app: string) => sales?.sources.find((s) => s.app === app);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6">
        <nav className="mb-3 text-sm"><Link href="/" className="text-zinc-400 transition-colors hover:text-white">← InnovFin</Link></nav>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">GST Filing</h1>
            <p className="text-sm text-zinc-400">Innovfix Private Limited · GSTIN 29AAICI1603A1Z3</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-400">Return month</span>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
              className="rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-zinc-100 [color-scheme:dark]" />
          </label>
        </div>
      </header>

      {/* Stepper */}
      <ol className="mb-8 flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => {
          const n = i + 1;
          // A step is "done" (green ✓) once you've passed it — and the final Review & File
          // step turns green too once the GSTR-3B is computed (you're ready to file).
          const done = n < step || (n === step && n === STEPS.length && !!g3);
          const active = n === step && !done;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                active ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30" : done ? "bg-emerald-500 text-white" : "bg-white/10 text-zinc-500"}`}>
                {done ? "✓" : n}
              </span>
              <span className={`truncate ${active ? "font-semibold text-white" : "text-zinc-500"}`}>{label}</span>
              {n < STEPS.length && <span className="mx-1 h-px flex-1 bg-white/10" />}
            </li>
          );
        })}
      </ol>

      {error && <p className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      {/* STEP 1 — SALES */}
      {step === 1 && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-400">
            Sources auto-fetch where API/DB access is configured; any not-yet-configured
            source can be uploaded manually as a fallback.
          </p>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
            <table className="min-w-full divide-y divide-white/10 text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr><th className="px-3 py-2">App</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Manual upload (fallback)</th><th className="px-3 py-2 text-right">Taxable</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {plan.map((s) => {
                  const st = statusFor(s.app);
                  const auto = s.mode === "auto" && s.configured;
                  return (
                    <tr key={s.app} className="transition-colors hover:bg-white/[0.025]">
                      <td className="px-3 py-2 font-medium text-zinc-100">{s.app}<span className="ml-2 text-xs text-zinc-500">HSN {s.hsn}</span></td>
                      <td className="px-3 py-2 text-zinc-300">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${auto ? "bg-emerald-500/15 text-emerald-300" : s.mode === "manual" ? "bg-amber-500/15 text-amber-300" : "bg-white/10 text-zinc-400"}`}>
                          {auto ? "Auto ✓" : s.mode === "manual" ? "Manual" : "Auto · add key"}
                        </span>
                        <span className="ml-2 text-xs text-zinc-500">{PROVIDER_LABEL[s.provider] ?? s.provider}</span>
                      </td>
                      <td className="px-3 py-2">
                        {st ? (
                          <span className={st.status === "ok" ? "text-emerald-400" : st.status === "error" ? "text-red-400" : "text-amber-400"}>
                            {st.status === "ok" ? `✓ ${st.count ?? 0} txns` : st.status === "error" ? "error" : "pending"}
                          </span>
                        ) : <span className="text-zinc-600">—</span>}
                        {st?.message && <span className="ml-1 text-xs text-zinc-500">{st.message}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input type="file" accept=".csv,.xlsx,.xls"
                          onChange={(e) => setFiles((f) => ({ ...f, [s.app]: e.target.files?.[0] }))}
                          className="block w-full max-w-[200px] text-xs text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-xs file:text-zinc-200 hover:file:bg-white/20" />
                        {files[s.app] && <span className="text-xs text-emerald-400">✓ {files[s.app]?.name}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{st?.taxable != null ? inr(st.taxable) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              {sales && (
                <tfoot className="bg-white/5 font-semibold text-white">
                  <tr><td className="px-3 py-2" colSpan={4}>GSTR-1 total taxable {tieOut && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">✓ tie-out</span>}</td><td className="px-3 py-2 text-right tabular-nums">{inr(sales.total.taxable)}</td></tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={runSales} disabled={busy}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-400 disabled:opacity-50">
              {busy ? "Fetching…" : "Fetch & compute GSTR-1"}
            </button>
            {sales && sales.lines.length > 0 && (
              <button onClick={downloadGstr1}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-400">
                ⬇ Download GSTR-1 report
              </button>
            )}
            <button onClick={() => setStep(2)} disabled={!sales || sales.lines.length === 0}
              className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50">
              Next: Purchases / RCM →
            </button>
          </div>
        </section>
      )}

      {/* STEP 2 — PURCHASES / RCM */}
      {step === 2 && (
        <section className="space-y-6">
          <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
            <h3 className="font-semibold text-zinc-100">GSTR-2B — Input Tax Credit (Table 4(A)(5))</h3>
            <p className="mb-3 text-xs text-zinc-400">Upload the GSTR-2B downloaded from the portal — the 4(A)(5) ITC is auto-extracted (you can still edit below before computing).</p>
            <label className="mb-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20">
              ⬆ Upload GSTR-2B (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadGstr2b(f); }} />
            </label>
            {itcInfo && <p className="mb-2 text-xs text-emerald-400">{itcInfo}</p>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <NumField label="Taxable" value={itc.taxable} onChange={(v) => setItc({ ...itc, taxable: v })} />
              <NumField label="IGST" value={itc.igst} onChange={(v) => setItc({ ...itc, igst: v })} />
              <NumField label="CGST" value={itc.cgst} onChange={(v) => setItc({ ...itc, cgst: v })} />
              <NumField label="SGST" value={itc.sgst} onChange={(v) => setItc({ ...itc, sgst: v })} />
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
            <h3 className="font-semibold text-zinc-100">RCM — Reverse charge (Table 3.1(d))</h3>
            <p className="mb-3 text-xs text-zinc-400">Upload bank statements (or a categorised RCM pivot). A pivot is read exactly; raw statements are keyword-matched and AI-suggested for review. Foreign → IGST 18%; unregistered rent → CGST+SGST 9%.</p>
            <label className="mb-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20">
              ⬆ Upload bank statement / RCM pivot
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBankRcm(f); }} />
            </label>
            {rcmNote && <p className="mb-2 text-xs text-zinc-400">{rcmNote}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-zinc-400">Foreign (import of services)</p>
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Taxable (₹ paid)" value={foreign.taxable} onChange={(v) => setForeign({ taxable: v, igst: round2(v * 0.18) })} />
                  <NumField label="IGST" value={foreign.igst} onChange={(v) => setForeign({ ...foreign, igst: v })} />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-zinc-400">Rent (unregistered landlords)</p>
                <div className="grid grid-cols-3 gap-3">
                  <NumField label="Taxable" value={rent.taxable} onChange={(v) => setRent({ taxable: v, cgst: round2(v * 0.09), sgst: round2(v * 0.09) })} />
                  <NumField label="CGST" value={rent.cgst} onChange={(v) => setRent({ ...rent, cgst: v })} />
                  <NumField label="SGST" value={rent.sgst} onChange={(v) => setRent({ ...rent, sgst: v })} />
                </div>
              </div>
            </div>
            {rcmReview.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-500/10 p-3">
                <p className="mb-2 text-xs font-semibold text-amber-300">⚠ AI suggestions — confirm before adding to RCM ({rcmReview.length})</p>
                <ul className="space-y-1 text-xs">
                  {rcmReview.map((it, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-zinc-300"><span className="rounded bg-white/10 px-1 py-0.5 text-[10px] uppercase text-zinc-300">{it.category}</span> {it.vendor} — ₹{inr(it.amount)} <span className="text-zinc-500">· {it.reason}</span></span>
                      <button onClick={() => addReview(it)} className="shrink-0 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20">+ add</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
            <NumField label="Late fee" value={lateFee} onChange={setLateFee} />
            <NumField label="Interest" value={interest} onChange={setInterest} />
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setStep(1)} className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10">← Back</button>
            <button onClick={runGstr3b} disabled={busy}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-400 disabled:opacity-50">
              {busy ? "Computing…" : "Compute GSTR-3B →"}
            </button>
          </div>
        </section>
      )}

      {/* STEP 3 — REVIEW & FILE */}
      {step === 3 && g3 && (
        <section className="space-y-6">
          <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-5 shadow-[0_0_60px_-20px_rgba(99,102,241,0.6)]">
            <p className="text-sm text-indigo-300">Total cash challan payable</p>
            <p className="text-3xl font-bold tracking-tight text-white">₹{inr(g3.cashChallan.total.grandTotal)}</p>
            <p className="mt-1 text-xs text-indigo-300">
              RCM (cash) ₹{inr(g3.cashChallan.rcm.total)} · Regular after ITC ₹{inr(g3.cashChallan.regular.total)}
            </p>
          </div>

          {g3.reconciliation && (
            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-200">Review — reconciliation checks</h3>
                {g3.reconciliation.gstr1Vs3b.ok && g3.reconciliation.internal.ok
                  ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">✓ all passed — safe to file</span>
                  : <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-300">⚠ review needed</span>}
              </div>
              <ul className="space-y-1 text-xs">
                {[...g3.reconciliation.gstr1Vs3b.checks, ...g3.reconciliation.internal.checks].map((c, i) => (
                  <li key={i} className="flex items-center justify-between gap-3">
                    <span className="text-zinc-300"><span className={c.ok ? "text-emerald-400" : "text-red-400"}>{c.ok ? "✓" : "✗"}</span> {c.label}</span>
                    <span className={`tabular-nums ${c.ok ? "text-zinc-500" : "font-semibold text-red-400"}`}>Δ {inr(c.diff)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <MiniTable title="Table 6.1 — Payment of tax" head={["", "Liability", "ITC used", "Cash"]}
            rows={(["igst", "cgst", "sgst"] as const).map((k) => [k.toUpperCase(), inr(g3.table61[k].liability), inr(g3.table61[k].itcUsed), inr(g3.table61[k].cash)])} />

          <MiniTable title="Cash challan breakup" head={["", "IGST", "CGST", "SGST", "Total"]}
            rows={[
              ["RCM (mandatory cash)", inr(g3.cashChallan.rcm.igst), inr(g3.cashChallan.rcm.cgst), inr(g3.cashChallan.rcm.sgst), inr(g3.cashChallan.rcm.total)],
              ["Regular (after ITC)", inr(g3.cashChallan.regular.igst), inr(g3.cashChallan.regular.cgst), inr(g3.cashChallan.regular.sgst), inr(g3.cashChallan.regular.total)],
              ["TOTAL CHALLAN", inr(g3.cashChallan.total.igst), inr(g3.cashChallan.total.cgst), inr(g3.cashChallan.total.sgst), inr(g3.cashChallan.total.grandTotal)],
            ]} />

          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="mb-1 text-sm font-semibold text-zinc-700">File on the GST portal</h3>
            <p className="mb-3 text-xs text-zinc-500">
              InnovFin prepares the figures; the return is submitted on the government portal. Download the working,
              enter the <span className="font-medium">Table 6.1</span> amounts on the portal, and pay the challan of
              <span className="font-medium"> ₹{inr(g3.cashChallan.total.grandTotal)}</span>.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={downloadReport} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
                ⬇ Download final GSTR-3B report
              </button>
              <button onClick={downloadFullWorkbook} disabled={busy} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                {busy ? "Building…" : "⬇ Download full GST working (all sheets)"}
              </button>
              <a href="https://www.gst.gov.in" target="_blank" rel="noreferrer"
                className="rounded-lg border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
                Open GST portal ↗
              </a>
            </div>
          </div>

          <button onClick={() => setStep(2)} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">← Back</button>
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
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums text-zinc-900" />
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
