"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { inr } from "@/lib/format";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import { SiteFooter } from "@/components/site-footer";

type Summary = {
  doc_id: string;
  status: string;
  vendor_name: string | null;
  vendor_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  currency: string | null;
  sender: string | null;
  received_date: string | null;
};
type ReviewItem = Summary & {
  reasons: string[];
  confidence: number | null;
  low_confidence_fields: string[];
  doc_type: string | null;
  filename: string | null;
};
type ListResponse = { needsReview: ReviewItem[]; accepted: Summary[] };

const EDITABLE = [
  { key: "invoice_number", label: "Invoice number", type: "text" },
  { key: "invoice_date", label: "Invoice date", type: "date" },
  { key: "total", label: "Total", type: "number" },
  { key: "vendor_gstin", label: "Vendor GSTIN", type: "text" },
  { key: "vendor_name", label: "Vendor name", type: "text" },
] as const;

function prettyReason(r: string): string {
  const m = r.match(/mandatory field '([^']+)' is missing/i);
  if (m) return `Missing ${m[1].replace(/_/g, " ")}`;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function fileUrl(docId: string): string {
  return `/api/invoices/${encodeURIComponent(docId)}/file`;
}

function previewKind(item: ReviewItem): "pdf" | "image" | "text" {
  const dt = (item.doc_type ?? "").toLowerCase();
  const fn = (item.filename ?? "").toLowerCase();
  if (dt.includes("pdf") || fn.endsWith(".pdf")) return "pdf";
  if (dt.includes("image") || /\.(png|jpe?g|tiff?|webp|gif|bmp)$/.test(fn)) return "image";
  return "text";
}

export default function InvoiceInbox() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [tab, setTab] = useState<"review" | "accepted">("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/invoices/list", { cache: "no-store" });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `Failed to load (${res.status})`);
      setData({ needsReview: r.needsReview ?? [], accepted: r.accepted ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Optimistically drop the acted invoice from the queue, then re-sync in the background.
  const handleActed = useCallback(
    (docId: string) => {
      setData((d) => (d ? { ...d, needsReview: d.needsReview.filter((x) => x.doc_id !== docId) } : d));
      load();
    },
    [load],
  );

  const reviewCount = data?.needsReview.length ?? 0;
  const acceptedCount = data?.accepted.length ?? 0;

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <Link href="/" className="group flex items-center gap-2.5">
            <BrandMark className="h-8 w-8 transition-transform duration-300 group-hover:scale-105" />
            <span className="flex items-center gap-2 text-sm">
              <span className="font-bold tracking-tight text-zinc-900">InnovFin</span>
              <span className="text-zinc-300">/</span>
              <span className="font-medium text-zinc-500 transition-colors group-hover:text-zinc-800">Invoice Inbox</span>
            </span>
          </Link>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Link
          href="/"
          className="mb-5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to automations
        </Link>

        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Invoice Inbox</h1>
            <p className="mt-0.5 text-sm text-zinc-500">
              Invoices captured from <span className="font-medium text-zinc-700">invoices@innovfix.in</span> — review the flagged ones and act.
            </p>
          </div>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:bg-zinc-50"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Tabs — needs-review is the default, prominent, human-work queue. */}
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setTab("review")}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-all ${
              tab === "review"
                ? "border-amber-400/60 bg-amber-50 text-amber-800 shadow-sm ring-1 ring-amber-400/30"
                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
            }`}
          >
            <span className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold ${reviewCount > 0 ? "bg-amber-500 text-white" : "bg-zinc-200 text-zinc-500"}`}>
              {reviewCount}
            </span>
            Needs review
          </button>
          <button
            onClick={() => setTab("accepted")}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-all ${
              tab === "accepted"
                ? "border-emerald-400/60 bg-emerald-50 text-emerald-800 shadow-sm ring-1 ring-emerald-400/30"
                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
            }`}
          >
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-zinc-200 px-1.5 text-xs font-bold text-zinc-600">
              {acceptedCount}
            </span>
            Accepted
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button onClick={load} className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium hover:bg-red-100">Retry</button>
          </div>
        )}

        {loading && !data ? (
          <p className="py-16 text-center text-sm text-zinc-400">Loading invoices…</p>
        ) : tab === "review" ? (
          reviewCount === 0 ? (
            <EmptyReview />
          ) : (
            <div className="space-y-5">
              {data!.needsReview.map((item) => (
                <ReviewCard key={item.doc_id} item={item} onActed={handleActed} onError={setError} />
              ))}
            </div>
          )
        ) : (
          <AcceptedList rows={data?.accepted ?? []} />
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

function EmptyReview() {
  return (
    <div className="rounded-2xl border border-dashed border-emerald-300/70 bg-emerald-50/40 py-16 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <p className="mt-3 text-sm font-semibold text-zinc-800">You&apos;re all caught up</p>
      <p className="mt-1 text-sm text-zinc-500">No invoices need review right now.</p>
    </div>
  );
}

function ReviewCard({
  item,
  onActed,
  onError,
}: {
  item: ReviewItem;
  onActed: (docId: string) => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const startEdit = () => {
    setEdits({
      invoice_number: item.invoice_number ?? "",
      invoice_date: item.invoice_date ?? "",
      total: item.total != null ? String(item.total) : "",
      vendor_gstin: item.vendor_gstin ?? "",
      vendor_name: item.vendor_name ?? "",
    });
    setEditing(true);
  };

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await fetch("/api/invoices/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId: item.doc_id, ...payload }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `Action failed (${res.status})`);
      onActed(item.doc_id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  function saveAndAccept() {
    const original: Record<string, string> = {
      invoice_number: item.invoice_number ?? "",
      invoice_date: item.invoice_date ?? "",
      total: item.total != null ? String(item.total) : "",
      vendor_gstin: item.vendor_gstin ?? "",
      vendor_name: item.vendor_name ?? "",
    };
    const changed: Record<string, string> = {};
    for (const { key } of EDITABLE) {
      const v = (edits[key] ?? "").trim();
      if (v !== (original[key] ?? "").trim()) changed[key] = v;
    }
    post({ action: "edit_approve", fields: changed }, "save");
  }

  const kind = previewKind(item);
  const missing = new Set(item.reasons.flatMap((r) => (r.match(/'([^']+)'/)?.[1] ? [r.match(/'([^']+)'/)![1]] : [])));

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="grid lg:grid-cols-2">
        {/* LEFT — extracted fields, reasons, controls */}
        <div className="border-b border-zinc-100 p-5 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-zinc-900">
                {item.invoice_number || <span className="text-zinc-400">No invoice number</span>}
              </h3>
              <p className="mt-0.5 truncate text-xs text-zinc-500">
                {item.sender || "unknown sender"}
                {item.received_date && <span className="text-zinc-400"> · received {item.received_date}</span>}
              </p>
            </div>
            {item.confidence != null && (
              <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500" title="Pipeline confidence">
                {Math.round(item.confidence * 100)}% conf.
              </span>
            )}
          </div>

          {/* Why flagged */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.reasons.length === 0 ? (
              <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">Flagged for review</span>
            ) : (
              item.reasons.map((r, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-500/20">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9v4M12 17h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z" />
                  </svg>
                  {prettyReason(r)}
                </span>
              ))
            )}
          </div>

          {/* Fields */}
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            {editing ? (
              EDITABLE.map(({ key, label, type }) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
                  <input
                    type={type}
                    value={edits[key] ?? ""}
                    onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                  />
                </label>
              ))
            ) : (
              <>
                <ViewField label="Invoice number" value={item.invoice_number} flagged={missing.has("invoice_number")} />
                <ViewField label="Invoice date" value={item.invoice_date} flagged={missing.has("invoice_date")} />
                <ViewField label="Total" value={item.total != null ? `₹${inr(item.total)}` : null} flagged={missing.has("total")} />
                <ViewField label="Vendor GSTIN" value={item.vendor_gstin} flagged={missing.has("vendor_gstin")} mono />
                <ViewField label="Vendor" value={item.vendor_name} />
                <ViewField label="Buyer GSTIN" value={item.buyer_gstin} mono />
              </>
            )}
          </dl>

          {/* Controls */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={saveAndAccept}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === "save" ? "Saving…" : "Save & accept"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  disabled={busy !== null}
                  className="rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => post({ action: "approve" }, "approve")}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                <button
                  onClick={startEdit}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  Edit
                </button>
                <button
                  onClick={() => post({ action: "reject" }, "reject")}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  {busy === "reject" ? "Rejecting…" : "Not an invoice"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* RIGHT — original document */}
        <div className="flex flex-col bg-zinc-50/60">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2">
            <span className="truncate text-xs font-medium text-zinc-500" title={item.filename ?? undefined}>
              {item.filename || "document"}
            </span>
            <a href={fileUrl(item.doc_id)} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-teal-700 hover:underline">
              Open ↗
            </a>
          </div>
          <div className="min-h-[320px] flex-1 p-3">
            {kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(item.doc_id)} alt={item.filename ?? "invoice"} className="mx-auto max-h-[440px] w-auto rounded-md border border-zinc-200 bg-white object-contain" />
            ) : (
              <iframe src={fileUrl(item.doc_id)} title={item.filename ?? "document"} className="h-[440px] w-full rounded-md border border-zinc-200 bg-white" />
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function ViewField({ label, value, flagged, mono }: { label: string; value: string | null; flagged?: boolean; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-sm ${value ? "text-zinc-900" : flagged ? "font-medium text-amber-600" : "text-zinc-400"} ${mono ? "font-mono text-[13px]" : ""}`}>
        {value || (flagged ? "missing" : "—")}
      </dd>
    </div>
  );
}

function AcceptedList({ rows }: { rows: Summary[] }) {
  if (rows.length === 0) {
    return <p className="py-16 text-center text-sm text-zinc-400">No accepted invoices yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-zinc-200 text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2">Invoice #</th>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Vendor GSTIN</th>
            <th className="px-3 py-2">Sender</th>
            <th className="px-3 py-2">Received</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r) => (
            <tr key={r.doc_id} className="transition-colors hover:bg-zinc-50">
              <td className="px-3 py-2 font-medium text-zinc-900">{r.invoice_number || "—"}</td>
              <td className="px-3 py-2 text-zinc-600">{r.invoice_date || "—"}</td>
              <td className="px-3 py-2 font-mono text-[13px] text-zinc-600">{r.vendor_gstin || "—"}</td>
              <td className="max-w-[16rem] truncate px-3 py-2 text-zinc-600" title={r.sender ?? undefined}>{r.sender || "—"}</td>
              <td className="px-3 py-2 text-zinc-500">{r.received_date || "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-800">{r.total != null ? `₹${inr(r.total)}` : "—"}</td>
              <td className="px-3 py-2 text-right">
                <a href={fileUrl(r.doc_id)} target="_blank" rel="noreferrer" className="text-xs font-medium text-teal-700 hover:underline">View ↗</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
