/**
 * GSTR-1 core logic — ported 1:1 from the rupee-validated `gstr1-core.js`
 * (Innovfix "GSTR-1 Web Tool", validated against the May 2026 filing).
 *
 * Pure functions over an array-of-arrays (AOA) parsed from CSV/XLSX. No I/O here,
 * so it is identical in the browser, the Next.js server, and the test harness.
 * DO NOT change the arithmetic without re-validating against a filed month.
 */

export const GST_RATE = 0.18; // 18% => CGST 9% + SGST 9%

export type ParserType = "invoicewise" | "razorpay" | "phonepe" | "cashfree";

export interface AppDefault {
  type: ParserType;
  hsn: number;
  service: string;
}

/** Per-app defaults (editable per upload in the UI, exactly like the web tool). */
export const APP_DEFAULTS: Record<string, AppDefault> = {
  "Hima":              { type: "invoicewise", hsn: 998439, service: "Audio & Video call - Other on-line contents nowhere else classified" },
  "Sudar":             { type: "razorpay",    hsn: 999299, service: "Other Educational support services - Application helping in Exams Preparation" },
  "Thedal":            { type: "razorpay",    hsn: 998433, service: "On-line video content - Providing guidances related to business through videos" },
  "Bangalore Connect": { type: "phonepe",     hsn: 998599, service: "Other support services nowhere else classified - Application connecting Professionals around Bangalore" },
  "Only Care":         { type: "cashfree",    hsn: 998439, service: "Online care - Other on-line contents nowhere else classified" },
  "Unman":             { type: "invoicewise", hsn: 998439, service: "AI Chat based Text media - Other on-line contents nowhere else classified" },
};

export const APP_ORDER = ["Hima", "Sudar", "Thedal", "Bangalore Connect", "Only Care", "Unman"] as const;

export type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];
export type AOA = Row[];

export interface Measurement {
  taxable: number;
  invoiceValueActual: number;
  count: number;
  serialMin: number | null;
  serialMax: number | null;
  basis: string;
}

export interface Gstr1Line {
  app: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  invoiceValueCalc: number;
  invoiceValueActual: number;
  roundOff: number;
  hsn?: number;
  service?: string;
  count: number;
  serialMin: number | null;
  serialMax: number | null;
  basis: string;
}

function norm(s: Cell): string {
  return (s === null || s === undefined) ? "" : String(s).trim().toLowerCase();
}

/** Parse a numeric cell, stripping commas, spaces and ₹. Returns NaN if not numeric. */
export function num(v: Cell): number {
  if (v === null || v === undefined || v === "") return NaN;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[, ]/g, "").replace(/[₹]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

/** Round to 2 decimals (display only — internal sums keep full precision). */
export function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** First row (within the first 60) containing ALL required tokens (case-insensitive substring). */
function findHeaderRow(aoa: AOA, required: string[]): number {
  for (let i = 0; i < Math.min(aoa.length, 60); i++) {
    const cells = (aoa[i] || []).map(norm);
    const ok = required.every((req) =>
      cells.some((c) => c === req || c.indexOf(req) !== -1)
    );
    if (ok) return i;
  }
  return -1;
}

/** Build {lowercased column name -> index} from a header row (first occurrence wins). */
function colIndex(headerRow: Row): Record<string, number> {
  const map: Record<string, number> = {};
  (headerRow || []).forEach((h, i) => {
    const k = norm(h);
    if (k && !(k in map)) map[k] = i;
  });
  return map;
}

function findCol(map: Record<string, number>, names: string[]): number {
  for (let j = 0; j < names.length; j++) {
    const want = norm(names[j]);
    if (want in map) return map[want];
    for (const k in map) { if (k.indexOf(want) !== -1) return map[k]; }
  }
  return -1;
}

// ---- Parsers. Each returns a raw measurement object. ----

/** Invoice-wise (Hima / OnlyCare / Unman dashboards): Taxable Value summed directly. */
function parseInvoiceWise(aoa: AOA): Measurement {
  const hr = findHeaderRow(aoa, ["taxable value"]);
  if (hr < 0) throw new Error("Could not find an invoice-wise header (need a 'Taxable Value' column).");
  const m = colIndex(aoa[hr]);
  const ci = findCol(m, ["invoice value", "amount", "collection (inr)", "collection"]);
  const ct = findCol(m, ["taxable value", "tv", "taxable"]);
  const cn = findCol(m, ["invoice no", "invoice number", "srl no"]);
  let taxable = 0, invVal = 0, count = 0;
  let smin: number | null = null, smax: number | null = null;
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const t = num(row[ct]);
    const iv = ci >= 0 ? num(row[ci]) : NaN;
    const hasData = !isNaN(t) || !isNaN(iv);
    if (!hasData) continue;
    if (!isNaN(t)) taxable += t;
    if (!isNaN(iv)) invVal += iv;
    count++;
    if (cn >= 0) {
      const sn = num(row[cn]);
      if (!isNaN(sn)) { if (smin === null || sn < smin) smin = sn; if (smax === null || sn > smax) smax = sn; }
    }
  }
  return {
    taxable,
    invoiceValueActual: invVal || r2(taxable * (1 + GST_RATE)),
    count, serialMin: smin, serialMax: smax,
    basis: "Invoice-wise (taxable summed directly)",
  };
}

/** Razorpay (Sudar / Unman-gateway): TYPE='payment' rows, GROSS 'amount' incl. GST. */
function parseRazorpay(aoa: AOA): Measurement {
  let hr = findHeaderRow(aoa, ["entity_id", "amount"]);
  if (hr < 0) hr = findHeaderRow(aoa, ["amount", "credit"]);
  if (hr < 0) throw new Error("Could not find a Razorpay header (need 'entity_id'/'amount').");
  const m = colIndex(aoa[hr]);
  const cAmt = findCol(m, ["amount"]);
  const cType = findCol(m, ["type"]);
  let amt = 0, count = 0;
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const ty = cType >= 0 ? norm(row[cType]) : "payment";
    if (ty !== "payment") continue;
    const a = num(row[cAmt]);
    if (isNaN(a)) continue;
    amt += a; count++;
  }
  const taxable = amt / (1 + GST_RATE);
  return { taxable, invoiceValueActual: amt, count, serialMin: null, serialMax: null, basis: "Razorpay: TYPE=payment, gross amount" };
}

/** PhonePe (Bangalore Connect): Transaction Status=SUCCESS, sum Transaction Amount. */
function parsePhonePe(aoa: AOA): Measurement {
  const hr = findHeaderRow(aoa, ["transaction status", "transaction amount"]);
  if (hr < 0) throw new Error("Could not find a PhonePe header (need 'Transaction Status' & 'Transaction Amount').");
  const m = colIndex(aoa[hr]);
  const cAmt = findCol(m, ["transaction amount"]);
  const cStat = findCol(m, ["transaction status"]);
  let amt = 0, count = 0;
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (norm(row[cStat]) !== "success") continue;
    const a = num(row[cAmt]);
    if (isNaN(a)) continue;
    amt += a; count++;
  }
  return { taxable: amt / (1 + GST_RATE), invoiceValueActual: amt, count, serialMin: null, serialMax: null, basis: "PhonePe: status=SUCCESS, transaction amount" };
}

/** Cashfree (Only Care): Transaction Status=SUCCESS, sum Amount. */
function parseCashfree(aoa: AOA): Measurement {
  let hr = findHeaderRow(aoa, ["order id", "amount"]);
  if (hr < 0) hr = findHeaderRow(aoa, ["amount", "transaction status"]);
  if (hr < 0) throw new Error("Could not find a Cashfree header (need 'Order Id' & 'Amount').");
  const m = colIndex(aoa[hr]);
  const cAmt = findCol(m, ["amount"]);
  const cStat = findCol(m, ["transaction status", "status"]);
  let amt = 0, count = 0;
  for (let i = hr + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (cStat >= 0 && norm(row[cStat]) !== "success") continue;
    const a = num(row[cAmt]);
    if (isNaN(a)) continue;
    amt += a; count++;
  }
  return { taxable: amt / (1 + GST_RATE), invoiceValueActual: amt, count, serialMin: null, serialMax: null, basis: "Cashfree: status=SUCCESS, amount" };
}

const PARSERS: Record<ParserType, (aoa: AOA) => Measurement> = {
  invoicewise: parseInvoiceWise,
  razorpay: parseRazorpay,
  phonepe: parsePhonePe,
  cashfree: parseCashfree,
};

/** Run a parser by type on an AOA. */
export function parse(type: ParserType, aoa: AOA): Measurement {
  const fn = PARSERS[type];
  if (!fn) throw new Error("Unknown parser type: " + type);
  return fn(aoa);
}

export interface ToLineOpts { hsn?: number; service?: string; }

/** Turn a raw measurement into a GSTR-1 working line (CGST=SGST=9% of taxable, IGST=0). */
export function toLine(app: string, meas: Measurement, opts: ToLineOpts = {}): Gstr1Line {
  const d = APP_DEFAULTS[app] || ({} as AppDefault);
  const taxable = meas.taxable || 0;
  const cgst = taxable * (GST_RATE / 2);
  const sgst = taxable * (GST_RATE / 2);
  const invCalc = taxable + cgst + sgst;
  const invActual = (meas.invoiceValueActual != null) ? meas.invoiceValueActual : invCalc;
  return {
    app,
    taxable, igst: 0, cgst, sgst,
    invoiceValueCalc: invCalc,
    invoiceValueActual: invActual,
    roundOff: invActual - invCalc,
    hsn: opts.hsn != null ? opts.hsn : d.hsn,
    service: opts.service != null ? opts.service : d.service,
    count: meas.count || 0,
    serialMin: meas.serialMin, serialMax: meas.serialMax,
    basis: meas.basis || "",
  };
}

export interface HsnRow { hsn: number | string; taxable: number; cgst: number; sgst: number; igst: number; }
export interface Gstr1Total {
  taxable: number; igst: number; cgst: number; sgst: number;
  invoiceValueCalc: number; invoiceValueActual: number; count: number; roundOff: number;
}

/** Aggregate lines into HSN-wise rows (GSTR-1 Table 12) + a grand total. */
export function summarise(lines: Gstr1Line[]): { hsnRows: HsnRow[]; total: Gstr1Total } {
  const byHsn: Record<string, HsnRow> = {};
  lines.forEach((l) => {
    const h: number | string = l.hsn ?? "—";
    const key = String(h);
    if (!byHsn[key]) byHsn[key] = { hsn: h, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    byHsn[key].taxable += l.taxable; byHsn[key].cgst += l.cgst; byHsn[key].sgst += l.sgst;
  });
  const hsnRows = Object.keys(byHsn).map((k) => byHsn[k]);
  const total = lines.reduce<Gstr1Total>((a, l) => {
    a.taxable += l.taxable; a.cgst += l.cgst; a.sgst += l.sgst;
    a.invoiceValueCalc += l.invoiceValueCalc; a.invoiceValueActual += l.invoiceValueActual; a.count += l.count;
    return a;
  }, { taxable: 0, igst: 0, cgst: 0, sgst: 0, invoiceValueCalc: 0, invoiceValueActual: 0, count: 0, roundOff: 0 });
  total.roundOff = total.invoiceValueActual - total.invoiceValueCalc;
  return { hsnRows, total };
}
