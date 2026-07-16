/**
 * Registry access — the invoice-intelligence store, read through its OWN MCP tools over localhost
 * (src/lib/invoice-mcp callTool → Python FastMCP on 127.0.0.1:8765). Read-only by construction:
 * only search_invoices / get_invoice are ever called — the estimate stays a pure function of
 * (invoice registry, period) with no store of its own and nothing written anywhere.
 *
 * We deliberately fetch WITHOUT invoice-date filters and bucket periods locally: a store-side date
 * filter would silently drop accepted rows whose invoice_date the extractor missed — those must
 * surface in the review bucket (NO_DATE), never vanish.
 */
import { callTool } from "@/lib/invoice-mcp";
import type { RegistryInvoice } from "./types";
import { round2 } from "./util";

/** Registry rows fetched per status — far above today's volume; revisit if the registry outgrows it. */
const SEARCH_LIMIT = 1000;

interface SearchRow {
  doc_id: string;
  invoice_date: string | null;
  total: number | null;
}

interface CanonicalDoc {
  doc_id?: string;
  fields?: Record<string, unknown>;
  source?: { sender?: string | null; received_date?: string | null };
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Canonical document → the flat invoice shape compute.ts works on. Exported for tests/smoke. */
export function toRegistryInvoice(doc: CanonicalDoc): RegistryInvoice {
  const f = doc.fields ?? {};
  return {
    docId: String(doc.doc_id ?? ""),
    invoiceNumber: str(f.invoice_number),
    invoiceDate: str(f.invoice_date),
    receivedDate: str(doc.source?.received_date),
    vendorName: str(f.vendor_name),
    vendorGstin: str(f.vendor_gstin),
    buyerGstin: str(f.buyer_gstin),
    currency: str(f.currency),
    taxableValue: num(f.taxable_value),
    igst: num(f.igst),
    cgst: num(f.cgst),
    sgst: num(f.sgst),
    cess: num(f.cess),
    total: num(f.total),
    hsnSac: str(f.hsn_sac),
    sender: str(doc.source?.sender),
  };
}

/** Small concurrency cap for the per-doc get_invoice fan-out against the localhost MCP. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * All ACCEPTED registry invoices with their full canonical fields (the GST breakup lives only in
 * the canonical document, not the search summary), optionally cut at received_to (inclusive) for
 * the point-in-time view.
 */
export async function fetchAcceptedInvoices(receivedTo?: string | null): Promise<RegistryInvoice[]> {
  const args: Record<string, unknown> = { status: "accepted", limit: SEARCH_LIMIT };
  if (receivedTo) args.received_to = receivedTo;
  const rows = await callTool<SearchRow[]>("search_invoices", args);
  const docs = await mapLimit(rows, 8, (r) => callTool<CanonicalDoc>("get_invoice", { doc_id: r.doc_id }));
  return docs.map(toRegistryInvoice);
}

/**
 * Count + gross value of needs_review rows that could belong to the period (dated inside it, or
 * undated) within the same received_to window — surfaced as an estimate caveat, never counted.
 */
export async function fetchNeedsReviewPending(period: string, receivedTo?: string | null): Promise<{ count: number; totalInclGst: number }> {
  const args: Record<string, unknown> = { status: "needs_review", limit: SEARCH_LIMIT };
  if (receivedTo) args.received_to = receivedTo;
  const rows = await callTool<SearchRow[]>("search_invoices", args);
  const relevant = rows.filter((r) => !r.invoice_date || String(r.invoice_date).startsWith(period));
  return { count: relevant.length, totalInclGst: round2(relevant.reduce((a, r) => a + (Number(r.total) || 0), 0)) };
}
