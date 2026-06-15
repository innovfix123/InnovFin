import type { AOA, Cell } from "@/gst-core/gstr1";
import { num } from "@/gst-core/gstr1";
import type { PurchaseInvoice } from "@/gst-core/reconcile";

/**
 * Parse a GST-portal GSTR-2B workbook → the ITC that feeds GSTR-3B Table 4.
 *
 * The reliable source is the portal's own "ITC Available" FORM SUMMARY sheet, whose
 * "4(A)(5)" row already states the availed-eligible IGST/CGST/SGST (it excludes anything
 * the portal marks "Not Available" → that sits in "ITC not available" as 4(D)(2)). We read
 * that row directly rather than re-summing invoices, so it ties to the portal to the rupee.
 * B2B invoices are also returned for the purchases↔2B reconciliation.
 */

function norm(s: Cell): string {
  return String(s ?? "").trim().toLowerCase();
}

export interface Gstr2bItc {
  igst: number;
  cgst: number;
  sgst: number;
}

export interface Gstr2bResult {
  /** Table 4(A)(5) — all other ITC available (the number used in GSTR-3B). */
  itcAvailable: Gstr2bItc & { taxable: number };
  /** Table 4(B) reversal — usually 0. */
  itcReversed: Gstr2bItc;
  /** Table 4(D) ineligible / "Not Available" — usually 0. */
  itcIneligible: Gstr2bItc;
  /** B2B invoices, for the purchases ↔ 2B reconciliation. */
  invoices: PurchaseInvoice[];
}

function findSheet(sheets: Record<string, AOA>, ...needles: string[]): AOA | undefined {
  for (const [name, aoa] of Object.entries(sheets)) {
    const n = name.toLowerCase();
    if (needles.every((nd) => n.includes(nd))) return aoa;
  }
  return undefined;
}

/** In a FORM-SUMMARY sheet, read the IGST/CGST/SGST in the three cells after the `tableRef` cell. */
function readSummaryRow(aoa: AOA | undefined, tableRef: string): Gstr2bItc {
  const zero = { igst: 0, cgst: 0, sgst: 0 };
  if (!aoa) return zero;
  for (const row of aoa) {
    const idx = (row || []).findIndex((c) => norm(c) === tableRef);
    if (idx >= 0) {
      return { igst: num(row[idx + 1]) || 0, cgst: num(row[idx + 2]) || 0, sgst: num(row[idx + 3]) || 0 };
    }
  }
  return zero;
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

/** B2B invoice rows: any row whose first cell is a valid GSTIN (skips headers/totals/separators). */
function parseB2bInvoices(aoa: AOA | undefined): PurchaseInvoice[] {
  if (!aoa) return [];
  const out: PurchaseInvoice[] = [];
  for (const row of aoa) {
    const gstin = String(row?.[0] ?? "").trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) continue;
    // Layout: 0 GSTIN · 7 Invoice number · 13 Taxable Value · 14 IGST · 15 CGST · 16 SGST
    out.push({
      gstin,
      invoiceNo: String(row[7] ?? "").trim(),
      taxable: num(row[13]) || 0,
      igst: num(row[14]) || 0,
      cgst: num(row[15]) || 0,
      sgst: num(row[16]) || 0,
    });
  }
  return out;
}

export function parseGstr2b(sheets: Record<string, AOA>): Gstr2bResult {
  const itc = readSummaryRow(findSheet(sheets, "itc available"), "4(a)(5)");
  const reversed = readSummaryRow(findSheet(sheets, "itc reversal"), "4(b)(2)");
  const ineligible = readSummaryRow(findSheet(sheets, "itc not available"), "4(d)(2)");
  const invoices = parseB2bInvoices(findSheet(sheets, "gstr - 2b - b2b") ?? findSheet(sheets, "b2b"));
  const taxable = invoices.reduce((a, i) => a + i.taxable, 0);
  return {
    itcAvailable: { ...itc, taxable },
    itcReversed: reversed,
    itcIneligible: ineligible,
    invoices,
  };
}
