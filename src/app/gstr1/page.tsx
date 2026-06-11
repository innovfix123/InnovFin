"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { APP_ORDER, APP_DEFAULTS, type ParserType } from "@/gst-core/gstr1";
import { inr } from "@/lib/format";

const PARSER_TYPES: ParserType[] = ["invoicewise", "razorpay", "phonepe", "cashfree"];
const TYPE_LABEL: Record<ParserType, string> = {
  invoicewise: "Invoice-wise (dashboard)",
  razorpay: "Razorpay",
  phonepe: "PhonePe",
  cashfree: "Cashfree",
};

type Line = {
  app: string; taxable: number; igst: number; cgst: number; sgst: number;
  invoiceValueActual: number; roundOff: number; hsn?: number; service?: string; count: number; basis: string;
};
type HsnRow = { hsn: number | string; taxable: number; igst: number; cgst: number; sgst: number };
type Total = { taxable: number; igst: number; cgst: number; sgst: number; invoiceValueActual: number; roundOff: number; count: number };
type Result = { period: string; lines: Line[]; hsnRows: HsnRow[]; total: Total; errors: Record<string, string> };

function defaultPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function Gstr1Page() {
  const [period, setPeriod] = useState<string>(defaultPeriod);
  const [types, setTypes] = useState<Record<string, ParserType>>(
    () => Object.fromEntries(APP_ORDER.map((a) => [a, APP_DEFAULTS[a].type])) as Record<string, ParserType>
  );
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anyFiles = APP_ORDER.some((a) => files[a]);

  const tieOut = useMemo(() => {
    if (!result) return null;
    const hsnSum = result.hsnRows.reduce((s, r) => s + r.taxable, 0);
    return Math.abs(hsnSum - result.total.taxable) < 1;
  }, [result]);

  async function generate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("period", period);
      for (const app of APP_ORDER) {
        const f = files[app];
        if (f) {
          fd.set(`file:${app}`, f);
          fd.set(`type:${app}`, types[app]);
        }
      }
      const res = await fetch("/api/gstr1", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setResult((await res.json()) as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadExcel() {
    if (!result) return;
    const res = await fetch("/api/gstr1/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GSTR-1 Working ${result.period || period}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6">
        <nav className="mb-3 text-sm">
          <Link href="/" className="text-zinc-500 hover:text-zinc-800">← InnovFin</Link>
        </nav>
        <h1 className="text-2xl font-bold tracking-tight">GSTR-1 B2C Working</h1>
        <p className="text-sm text-zinc-500">Innovfix Private Limited · GSTIN 29AAICI1603A1Z3</p>
        <div className="mt-4 flex items-center gap-2">
          <label className="text-sm font-medium text-zinc-600">Return month</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          />
        </div>
      </header>

      <p className="mb-3 text-sm text-zinc-500">
        Upload each app&apos;s report (CSV or XLSX). The source type is preset but changeable.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {APP_ORDER.map((app) => {
          const d = APP_DEFAULTS[app];
          const f = files[app];
          const err = result?.errors?.[app];
          return (
            <div key={app} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-zinc-900">{app}</h3>
                <span className="text-xs text-zinc-400">HSN {d.hsn}</span>
              </div>

              <label className="mt-3 block text-xs font-medium text-zinc-600">Source type</label>
              <select
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                value={types[app]}
                onChange={(e) => setTypes((t) => ({ ...t, [app]: e.target.value as ParserType }))}
              >
                {PARSER_TYPES.map((pt) => (
                  <option key={pt} value={pt}>{TYPE_LABEL[pt]}</option>
                ))}
              </select>

              <label className="mt-3 block text-xs font-medium text-zinc-600">Report file</label>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                className="mt-1 block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-zinc-200"
                onChange={(e) => setFiles((fs) => ({ ...fs, [app]: e.target.files?.[0] }))}
              />
              {f && <p className="mt-2 truncate text-xs text-emerald-600">✓ {f.name}</p>}
              {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={generate}
          disabled={!anyFiles || busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Computing…" : "Generate GSTR-1 Working"}
        </button>
        {result && (
          <button
            onClick={downloadExcel}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            ⬇ Download Excel
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {result && (
        <section className="mt-8 space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                tieOut ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
              }`}
            >
              {tieOut ? "✓ Tie-out OK (HSN = per-app)" : "✗ Tie-out mismatch"}
            </span>
            <span className="text-sm text-zinc-500">Period {result.period || period}</span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">App</th>
                  <th className="px-3 py-2 text-right">Taxable</th>
                  <th className="px-3 py-2 text-right">CGST</th>
                  <th className="px-3 py-2 text-right">SGST</th>
                  <th className="px-3 py-2 text-right">Invoice Value</th>
                  <th className="px-3 py-2 text-right">Round Off</th>
                  <th className="px-3 py-2 text-right">HSN</th>
                  <th className="px-3 py-2 text-right">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {result.lines.map((l) => (
                  <tr key={l.app}>
                    <td className="px-3 py-2 font-medium text-zinc-800">{l.app}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(l.taxable)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(l.cgst)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(l.sgst)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{inr(l.invoiceValueActual)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{inr(l.roundOff)}</td>
                    <td className="px-3 py-2 text-right text-zinc-500">{l.hsn}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{l.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-zinc-50 font-semibold">
                <tr>
                  <td className="px-3 py-2">TOTAL</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(result.total.taxable)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(result.total.cgst)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(result.total.sgst)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(result.total.invoiceValueActual)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(result.total.roundOff)}</td>
                  <td></td>
                  <td className="px-3 py-2 text-right tabular-nums">{result.total.count}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-zinc-700">HSN-wise summary (Table 12)</h3>
            <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
              <table className="min-w-full divide-y divide-zinc-200 text-sm">
                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">HSN</th>
                    <th className="px-3 py-2 text-right">Taxable</th>
                    <th className="px-3 py-2 text-right">CGST</th>
                    <th className="px-3 py-2 text-right">SGST</th>
                    <th className="px-3 py-2 text-right">Total Tax</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {result.hsnRows
                    .slice()
                    .sort((a, b) => b.taxable - a.taxable)
                    .map((r) => (
                      <tr key={String(r.hsn)}>
                        <td className="px-3 py-2 font-medium text-zinc-800">{r.hsn}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(r.taxable)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(r.cgst)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(r.sgst)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{inr(r.cgst + r.sgst + r.igst)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
