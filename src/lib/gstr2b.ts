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
  /**
   * Tax re-summed from the B2B invoice ROWS, held against the portal's own 4(A)(5) summary.
   * The two are read independently (rows by header, summary by table reference), so agreement is
   * real evidence the sheet was parsed correctly — and a mismatch is the tripwire for a column
   * shift, which otherwise produces confident nonsense. `matchesSummary` allows ₹1 of rounding;
   * it can also fall legitimately false when some rows sit in "ITC not available".
   */
  b2bTotals: Gstr2bItc & { taxable: number; invoices: number; matchesSummary: boolean };
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

/**
 * Where each value lives in the B2B sheet, found by HEADER TEXT — never by fixed position.
 *
 * The portal's own export is stable, but the workbook that reaches us has usually been worked on
 * in Excel first: our CA inserts classification columns (Incharge / Service / Section / TDS Rate /
 * New Section) between the supplier name and the invoice details. Every inserted column shifts the
 * money columns right, and a hardcoded index then reads the NEIGHBOURING field — silently, with no
 * error: taxable value lands in IGST, "Supply Attract Reverse Charge" ("No") parses as taxable 0,
 * and the reconciliation is quietly nonsense. Reading the header row immunises us against that.
 */
const B2B_HEADERS = {
  supplierName: ["trade/legal name", "trade name", "legal name"],
  invoiceNo: ["invoice number"],
  invoiceDate: ["invoice date"],
  taxable: ["taxable value"],
  // Both spellings: the portal writes "Integrated Tax(₹)", hand-built sheets often write "IGST".
  igst: ["integrated tax", "igst"],
  cgst: ["central tax", "cgst"],
  sgst: ["state/ut tax", "state tax", "sgst"],
  cess: ["cess"],
} as const;

type B2bColumns = Record<keyof typeof B2B_HEADERS, number>;

/** These five carry the reconciliation; without any one of them the sheet is unusable. */
const REQUIRED_COLUMNS: Array<keyof typeof B2B_HEADERS> = ["invoiceNo", "taxable", "igst", "cgst", "sgst"];

/**
 * Locate columns from the header band — every row above the first GSTIN row. The portal splits
 * headers across two rows ("Taxable Value (₹)" on one, "Integrated Tax(₹)" on the next), so all of
 * them are scanned and the first hit per field wins.
 */
function locateB2bColumns(aoa: AOA): B2bColumns {
  const cols = Object.fromEntries(Object.keys(B2B_HEADERS).map((k) => [k, -1])) as B2bColumns;
  for (const row of aoa) {
    if (GSTIN_RE.test(String(row?.[0] ?? "").trim().toUpperCase())) break; // data has started
    (row || []).forEach((cell, i) => {
      const text = norm(cell);
      if (!text) return;
      for (const [field, needles] of Object.entries(B2B_HEADERS) as Array<[keyof B2bColumns, readonly string[]]>) {
        if (cols[field] < 0 && needles.some((nd) => text.includes(nd))) cols[field] = i;
      }
    });
  }
  const missing = REQUIRED_COLUMNS.filter((f) => cols[f] < 0);
  if (missing.length > 0) {
    throw new Error(
      `GSTR-2B B2B sheet: could not find column(s) ${missing.join(", ")} by header text. ` +
      `The sheet layout changed — check the header row rather than trusting the parsed numbers.`,
    );
  }
  return cols;
}

/** B2B invoice rows: any row whose first cell is a valid GSTIN (skips headers/totals/separators). */
function parseB2bInvoices(aoa: AOA | undefined): PurchaseInvoice[] {
  if (!aoa) return [];
  const cols = locateB2bColumns(aoa);
  const at = (row: AOA[number], i: number) => (i >= 0 ? row[i] : undefined);
  const out: PurchaseInvoice[] = [];
  for (const row of aoa) {
    const gstin = String(row?.[0] ?? "").trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) continue;
    out.push({
      gstin,
      invoiceNo: String(at(row, cols.invoiceNo) ?? "").trim(),
      taxable: num(row[cols.taxable]) || 0,
      igst: num(row[cols.igst]) || 0,
      cgst: num(row[cols.cgst]) || 0,
      sgst: num(row[cols.sgst]) || 0,
      supplierName: String(at(row, cols.supplierName) ?? "").trim() || undefined,
      invoiceDate: String(at(row, cols.invoiceDate) ?? "").trim() || undefined,
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
  const summed = invoices.reduce(
    (a, i) => ({ igst: a.igst + i.igst, cgst: a.cgst + i.cgst, sgst: a.sgst + i.sgst }),
    { igst: 0, cgst: 0, sgst: 0 },
  );
  const matchesSummary =
    Math.abs(summed.igst - itc.igst) <= 1 &&
    Math.abs(summed.cgst - itc.cgst) <= 1 &&
    Math.abs(summed.sgst - itc.sgst) <= 1;
  return {
    itcAvailable: { ...itc, taxable },
    itcReversed: reversed,
    itcIneligible: ineligible,
    invoices,
    b2bTotals: { ...summed, taxable, invoices: invoices.length, matchesSummary },
  };
}
