import * as XLSX from "xlsx-js-style";
import type { AOA, Gstr1Line, Gstr1Total } from "@/gst-core/gstr1";
import type { Gstr3bResult } from "@/gst-core/gstr3b";
import type { RcmResult } from "@/gst-core/rcm";
import type { Gstr2bResult } from "@/lib/gstr2b";

/**
 * Assemble the multi-sheet "GST Working" workbook that mirrors Shoyab's manual workbook
 * sheet-for-sheet (same tab names, same column layout incl. CESS / Total Tax, same row
 * labels, same section structure), styled (cyan header bands, green totals, borders, 2-dp).
 *
 *   scope "gstr1": {Mon} GSTR-1 Summary + per-app raw sales sheets (his "GSTR1 Workings").
 *   scope "full" (default): Final WORKINGS, GSTR-1 Summary, per-app raw sales, GSTR-2B
 *     Summary, {Mon} 2B - B2B, Foreign Payments - RCM, Rent RCM, {Month} - Summary
 *     (his "GSTR-3B Workings"). Needs the GSTR-3B result; 2B/RCM detail when uploaded.
 */

const MFULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (p: string) => { const [y, m] = p.split("-").map(Number); return { y: y || 0, m: m || 1 }; };
const monthFull = (p: string) => { const { y, m } = ym(p); return `${MFULL[m - 1]} ${y}`; };            // "May 2026"
const monthAbbr = (p: string) => { const { y, m } = ym(p); return `${MABBR[m - 1]}-${String(y).slice(2)}`; }; // "May-26"
const monthYy = (p: string) => { const { y, m } = ym(p); return `${MFULL[m - 1]} ${String(y).slice(2)}`; };     // "May 26"
const dueDate = (p: string) => { let { y, m } = ym(p); m += 1; if (m > 12) { m = 1; y += 1; } return `20-${MABBR[m - 1]}-${y}`; };
function todayStr(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${MABBR[d.getMonth()]}-${d.getFullYear()}`;
}

const CYAN = "A6D8EC", GREEN = "C6E0B4", HEADTXT = "1F3864";
const MONEY = "#,##0.00";   // Shoyab shows zeros as 0.00 (not a dash)
const COUNT = "#,##0";
const THIN = { style: "thin", color: { rgb: "808080" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

const tot = (t: { igst: number; cgst: number; sgst: number }) => t.igst + t.cgst + t.sgst;

type Style = Record<string, unknown>;
type Row = (string | number)[];
function setCell(ws: XLSX.WorkSheet, r: number, c: number, s: Style): void {
  const ref = XLSX.utils.encode_cell({ r, c });
  const cell = ws[ref] as (XLSX.CellObject & { s?: Style }) | undefined;
  if (cell) cell.s = s; else (ws as Record<string, unknown>)[ref] = { t: "s", v: "", s };
}

interface SheetOpts { title?: number[]; header?: number[]; total?: number[]; count?: number[]; colW?: number[] }
function addSheet(wb: XLSX.WorkBook, name: string, rows: Row[], o: SheetOpts = {}): void {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const cols = Math.max(1, ...rows.map((r) => r?.length ?? 0));
  ws["!cols"] = o.colW ? o.colW.map((wch) => ({ wch })) : Array.from({ length: cols }, (_, c) => ({ wch: c === 0 ? 42 : 16 }));
  const title = new Set(o.title ?? []), header = new Set(o.header ?? []), total = new Set(o.total ?? []), count = new Set(o.count ?? []);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.length === 0) continue;
    for (let c = 0; c < row.length; c++) {
      const isNum = typeof row[c] === "number";
      const fmt = isNum ? (count.has(c) ? COUNT : MONEY) : undefined;
      let s: Style;
      if (title.has(r)) s = { font: { bold: true, sz: r === 0 ? 14 : 10, color: { rgb: r === 0 ? HEADTXT : "595959" } } };
      else if (header.has(r)) s = { font: { bold: true, sz: 10, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, border: BORDER, alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center", wrapText: true } };
      else if (total.has(r)) { s = { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREEN } }, border: { ...BORDER, top: { style: "medium", color: { rgb: "548235" } } }, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } }; if (fmt) s.numFmt = fmt; }
      else { s = { border: BORDER, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } }; if (fmt) s.numFmt = fmt; }
      setCell(ws, r, c, s);
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

function addRawSheet(wb: XLSX.WorkBook, name: string, aoa: AOA, headerRows = 1): void {
  const data = aoa.length ? aoa : [["(no transactions)"]];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const cols = Math.max(1, ...data.slice(0, 6).map((r) => r?.length ?? 1));
  ws["!cols"] = Array.from({ length: cols }, () => ({ wch: 18 }));
  for (let hr = 0; hr < Math.min(headerRows, data.length); hr++)
    for (let c = 0; c < (data[hr]?.length ?? 0); c++)
      setCell(ws, hr, c, { font: { bold: true, sz: 10, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, border: BORDER, alignment: { horizontal: "center", vertical: "center", wrapText: true } });
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

export interface FullWorkbookParts {
  period: string;
  lines: Gstr1Line[];
  total: Gstr1Total;
  perApp: { app: string; aoa: AOA }[];
  gstr3b?: Gstr3bResult | null;
  rcm?: RcmResult | null;
  twoB?: Gstr2bResult | null;
  /** Raw GSTR-2B "B2B" sheet (portal format) passed through verbatim for the 2B-B2B tab. */
  twoBRaw?: AOA | null;
  /** "gstr1" = GSTR-1 Summary + per-app sales only; "full" (default) = everything. */
  scope?: "gstr1" | "full";
}

/** Rich GSTR-1 summary (Shoyab's exact 16-column "B2C Sales - GSTR-1 Calculation" layout). */
function addGstr1Sheet(wb: XLSX.WorkBook, p: FullWorkbookParts, sheetName: string): void {
  const HEADERS = ["Application", "Taxable Value", "IGST", "CGST", "SGST", "Invoice Value", "Round Off", "Rounded Off Invoice Value", "B2C HSN", "Service Summary", "Serial Number Starting", "Serial Number Ending", "Total Invoices", "Cancelled Invoices", "Remaining Invoices", "Remarks"];
  const rows: Row[] = [
    ["Innovfix Private Limited"], ["GSTIN - 29AAICI1603A1Z3"],
    [`B2C Sales for ${monthFull(p.period)} - GSTR-1 Calculation`], [], HEADERS,
  ];
  for (const l of p.lines) rows.push([
    l.app, l.taxable, l.igst ?? 0, l.cgst, l.sgst, l.invoiceValueCalc, l.roundOff, l.invoiceValueActual,
    l.hsn ?? "", l.service ?? "", l.serialMin ?? "", l.serialMax ?? "", l.count, 0, l.count, "",
  ]);
  rows.push(["Total", p.total.taxable, p.total.igst, p.total.cgst, p.total.sgst, p.total.invoiceValueCalc, p.total.roundOff, p.total.invoiceValueActual, "", "", "", "", p.total.count, 0, p.total.count, ""]);
  addSheet(wb, sheetName, rows, {
    title: [0, 1, 2], header: [4], total: [rows.length - 1], count: [12, 13, 14],
    colW: [18, 16, 8, 14, 14, 16, 10, 20, 10, 52, 16, 16, 13, 13, 13, 30],
  });
}

export function buildFullWorkbook(p: FullWorkbookParts): Buffer {
  const wb = XLSX.utils.book_new();
  const full = (p.scope ?? "full") === "full" && !!p.gstr3b;
  const mf = monthFull(p.period), ma = monthAbbr(p.period);

  // ============ 1) Final WORKINGS (full scope) — Shoyab's outward/inward/challan working ============
  if (full && p.gstr3b) {
    const g3 = p.gstr3b, t31 = g3.table31, t4 = g3.table4, od = g3.offsetDetail, cc = g3.cashChallan;
    const itcTaxable = p.twoB?.itcAvailable.taxable ?? 0;
    const outB2C = [t31.outwardTaxable.taxable, 0, t31.outwardTaxable.cgst, t31.outwardTaxable.sgst, 0, t31.outwardTaxable.taxable + t31.outwardTaxable.cgst + t31.outwardTaxable.sgst];
    const outRcm = [t31.rcmLiability.taxable, t31.rcmLiability.igst, t31.rcmLiability.cgst, t31.rcmLiability.sgst, 0, t31.rcmLiability.taxable + tot(t31.rcmLiability)];
    const outTot = outB2C.map((_, i) => outB2C[i] + outRcm[i]);
    const inTax = [itcTaxable, t4.itcOther.igst, t4.itcOther.cgst, t4.itcOther.sgst, 0, itcTaxable + tot(t4.itcOther)];
    const inRcm = [0, t4.itcRcm.igst, t4.itcRcm.cgst, t4.itcRcm.sgst, 0, tot(t4.itcRcm)];
    const inTot = inTax.map((_, i) => inTax[i] + inRcm[i]);
    addSheet(wb, "Final WORKINGS", [
      ["Innovfix Private Limited"], ["GSTIN - 29AAICI1603A1Z3"], [`GSTR-3B Working - Period: ${mf}`], [`Due Date: ${dueDate(p.period)} | Filing within time`], [],
      ["Innovfix Private Limited"], ["GSTIN-29AAICI1603A1Z3"], [`PERIOD-${mf}`], ["GSTR-3B"], [],
      ["Outward Supplies:", "Amount", "IGST", "CGST", "SGST", "CESS", "Total"],
      ["Taxable - B2C", ...outB2C],
      ["Export, SEZ", 0, 0, 0, 0, 0, 0],
      ["NIL rated, Exempted", 0, 0, 0, 0, 0, 0],
      ["Reverse Charges", ...outRcm],
      ["Differential amount", 0, 0, 0, 0, 0, 0],
      ["Amendmends", 0, 0, 0, 0, 0, 0],
      ["Credit Notes", 0, 0, 0, 0, 0, 0],
      ["Non GST", 0, 0, 0, 0, 0, 0],
      ["", ...outTot],
      [],
      ["Inward Supplies:", "Amount", "IGST", "CGST", "SGST", "CESS", "Total"],
      ["Taxable", ...inTax],
      ["Composition", 0, 0, 0, 0, 0, 0],
      ["Debit Notes", 0, 0, 0, 0, 0, 0],
      ["E-Com Operator bills", 0, 0, 0, 0, 0, 0],
      ["Blocked/Reversed Charges", 0, 0, 0, 0, 0, 0],
      ["ITC Blocked U/s 17(5)", 0, 0, 0, 0, 0, 0],
      ["Reverse Charges", ...inRcm],
      ["Exempt, NIL Rated", 0, 0, 0, 0, 0, 0],
      ["Non GST Supply", 0, 0, 0, 0, 0, 0],
      ["", ...inTot],
      [],
      ["ITC Adjustment / Off Set (Rule 88A)", "", "IGST", "CGST", "SGST", "Total"],
      ["  IGST ITC used for IGST liability", "", od.igstUsedForIgst, "", "", od.igstUsedForIgst],
      ["  IGST ITC cross-utilized to CGST", "", od.igstCrossToCgst, "", "", od.igstCrossToCgst],
      ["  IGST ITC cross-utilized to SGST", "", od.igstCrossToSgst, "", "", od.igstCrossToSgst],
      ["  CGST ITC used for CGST liability", "", "", od.cgstOwnUsed, "", od.cgstOwnUsed],
      ["  SGST ITC used for SGST liability", "", "", "", od.sgstOwnUsed, od.sgstOwnUsed],
      [],
      ["Total Challan Payable", "", "CGST", "SGST", "IGST", "CESS", "Total"],
      ["Tax Payable", "", cc.total.cgst, cc.total.sgst, cc.total.igst, 0, cc.total.cgst + cc.total.sgst + cc.total.igst],
      ["Late Fees Payable", "", 0, 0, 0, 0, cc.lateFee],
      ["Interest (within due date)", "", 0, 0, 0, 0, cc.interest],
      ["TOTAL CHALLAN", "", cc.total.cgst, cc.total.sgst, cc.total.igst, 0, cc.total.grandTotal, "Create challan to this extent"],
      [],
      ["Breakup of Total Tax Payable", "", "IGST", "CGST", "SGST", "Total"],
      ["RCM Payable (IN CASH)", "", cc.rcm.igst, cc.rcm.cgst, cc.rcm.sgst, cc.rcm.total],
      ["Regular Tax Payable", "", cc.regular.igst, cc.regular.cgst, cc.regular.sgst, cc.regular.total],
      ["Late Fees Payable", "", 0, 0, 0, cc.lateFee],
      ["Interest", "", 0, 0, 0, cc.interest],
      ["Total Tax payable including all other charges", "", cc.total.igst, cc.total.cgst, cc.total.sgst, cc.total.grandTotal, "Challan amount to be created"],
      [],
      ["Notes:"],
      [`1. GSTR-1 filed for ${mf}. All docs B2C intra-state Karnataka (HSN 998439, 999299, 998433, 998599).`],
      [`2. ITC from GSTR-2B for ${mf} (Table 4(A)(5) - All Other ITC).`],
      ["3. RCM tax MUST be paid in cash (Sec 49(4) / 2(82)). Becomes ITC in the same period."],
      ["4. IGST ITC fully utilized first (Rule 88A), surplus split 50:50 between CGST and SGST."],
    ], { title: [0, 1, 2, 3, 5, 6, 7, 8], header: [10, 21, 33, 40, 47], total: [19, 31, 44, 52], colW: [44, 16, 16, 16, 16, 16, 18, 24] });
  }

  // ============ 2) {Mon} GSTR-1 Summary (always) ============
  addGstr1Sheet(wb, p, `${monthYy(p.period)} - GSTR-1 Summary`);

  // ============ 3) Per-app raw transaction sheets (always) ============
  for (const { app, aoa } of p.perApp) addRawSheet(wb, `${app} Sales`, aoa);

  if (full && p.gstr3b) {
    const g3 = p.gstr3b, t31 = g3.table31, t4 = g3.table4, t61 = g3.table61, od = g3.offsetDetail, cc = g3.cashChallan;

    // ============ 4) GSTR-2B {Mon} Summary ============
    const itc = p.twoB?.itcAvailable ?? { igst: t4.itcOther.igst, cgst: t4.itcOther.cgst, sgst: t4.itcOther.sgst, taxable: 0 };
    const b2bTaxAmt = itc.igst + itc.cgst + itc.sgst;
    const twoBRows: Row[] = [
      [`GSTR-2B Summary - ${mf}`],
      [`GSTIN: 29AAICI1603A1Z3 | Generated: ${todayStr()}`],
      [],
      ["Heading", "Taxable Value", "IGST", "CGST", "SGST", "CESS", "Total Tax"],
      ["All Other ITC (Table 4(A)(5)) - B2B Invoices (IMS)", itc.taxable, itc.igst, itc.cgst, itc.sgst, 0, b2bTaxAmt],
      ["Inward Supplies from ISD (Table 4(A)(4))", 0, 0, 0, 0, 0, 0],
      ["Inward Supplies liable for RCM (Table 3.1(d)/4(A)(3))", 0, 0, 0, 0, 0, 0],
      ["Import of Goods (Table 4(A)(1))", 0, 0, 0, 0, 0, 0],
      [],
      ["TOTAL ITC Available", itc.taxable, itc.igst, itc.cgst, itc.sgst, 0, b2bTaxAmt],
      [],
      ["Top suppliers (from B2B sheet of GSTR-2B):"],
    ];
    const twoBHeaders = [3];
    if (p.twoB?.invoices.length) {
      const bySup = new Map<string, number>();
      for (const i of p.twoB.invoices) bySup.set(i.gstin, (bySup.get(i.gstin) ?? 0) + i.taxable + i.igst + i.cgst + i.sgst);
      const top = [...bySup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      twoBHeaders.push(twoBRows.length);
      twoBRows.push(["GSTIN of supplier", "Total (incl. tax)"]);
      for (const [gstin, amt] of top) twoBRows.push([gstin, amt]);
    }
    addSheet(wb, `GSTR-2B ${ma} Summary`, twoBRows, { title: [0, 1], header: twoBHeaders, total: [9], colW: [48, 16, 16, 16, 16, 12, 16] });

    // ============ 5) {Mon} 2B - B2B (raw portal passthrough) ============
    if (p.twoBRaw?.length) addRawSheet(wb, `${ma} 2B - B2B`, p.twoBRaw, 6);
    else if (p.twoB?.invoices.length) {
      const b2b: AOA = [["GSTIN of supplier", "Invoice No", "Taxable Value (₹)", "IGST", "CGST", "SGST"]];
      for (const i of p.twoB.invoices) b2b.push([i.gstin, i.invoiceNo, i.taxable, i.igst, i.cgst, i.sgst]);
      addRawSheet(wb, `${ma} 2B - B2B`, b2b);
    }

    // ============ 6) Foreign Payments - RCM ============
    const fLines = p.rcm?.foreign.lines ?? [];
    const fTaxable = p.rcm?.foreign.taxable ?? t31.rcmLiability.taxable;
    const fIgst = p.rcm?.foreign.igst ?? t31.rcmLiability.igst;
    const fRows: Row[] = [
      [`Foreign Vendor Payments - RCM (${mf})`],
      [`Period: ${mf} | Source: HDFC + Yes Bank (per user pivot)`],
      ["Treatment: Import of Services (Sec 5(3)/(4) IGST Act) - IGST @ 18% under RCM"],
      [],
      ["S.No.", "Vendor (Expense Categorisation)", "Paid Amount (INR)", "IGST (18%)", "Total (Incl. GST)", "Incharge", "Status"],
    ];
    fLines.forEach((l, i) => fRows.push([i + 1, l.vendor, l.taxable, l.taxable * 0.18, l.taxable * 1.18, "", ""]));
    fRows.push([`TOTAL Foreign RCM (${mf})`, "", fTaxable, fIgst, fTaxable + fIgst, "", ""]);
    addSheet(wb, "Foreign Payments - RCM", fRows, { title: [0, 1, 2], header: [4], total: [fRows.length - 1], count: [0], colW: [8, 40, 18, 16, 18, 12, 12] });

    // ============ 7) Rent RCM ============
    const rLines = p.rcm?.rent.lines ?? [];
    const rTaxable = p.rcm?.rent.taxable ?? 0;
    const rCgst = p.rcm?.rent.cgst ?? t31.rcmLiability.cgst;
    const rSgst = p.rcm?.rent.sgst ?? t31.rcmLiability.sgst;
    const rRows: Row[] = [
      [`Rent RCM - ${mf}`],
      [`Period: ${mf} | Source: HDFC + Yes Bank`],
      ["Treatment: Rent to unregistered landlord (Sec 9(4) CGST Act) - CGST 9% + SGST 9% under RCM"],
      [],
      ["S.No.", "Vendor (Tag)", "Paid Amount (INR)", "CGST (9%)", "SGST (9%)", "Total Tax", "Incharge", "Status"],
    ];
    rLines.forEach((l, i) => rRows.push([i + 1, l.vendor, l.taxable, l.taxable * 0.09, l.taxable * 0.09, l.taxable * 0.18, "", ""]));
    rRows.push([`TOTAL Rent RCM (${mf})`, "", rTaxable, rCgst, rSgst, rCgst + rSgst, "", ""]);
    rRows.push([], ["Notes:"],
      ["1. Source: Pivot of 'Expense Categorisation' (HDFC + Yes Bank) filtered to 'RCM Applicable' rent items."],
      ["2. Unregistered landlord intra-state Karnataka -> CGST 9% + SGST 9% under RCM Sec 9(4)."],
      ["3. RCM tax MUST be paid in cash. Becomes ITC in the same period."]);
    addSheet(wb, "Rent RCM", rRows, { title: [0, 1, 2], header: [4], total: [5 + rLines.length], count: [0], colW: [8, 40, 18, 16, 16, 16, 12, 12] });

    // ============ 8) {Month} - Summary (formal Table 3.1 / 4 / 5 / 6.1) ============
    addSheet(wb, `${mf} - Summary`, [
      ["Innovfix Private Limited"], ["GSTIN - 29AAICI1603A1Z3"], [`GSTR-3B Working - Period: ${mf.toUpperCase()}`], [`Due date: ${dueDate(p.period)}`], [],
      ["TABLE 3.1 - OUTWARD SUPPLIES & RCM LIABILITY", "Taxable Value", "IGST", "CGST", "SGST", "Total Tax"],
      ["(a) Outward taxable supplies (other than zero-rated, nil, exempt)", t31.outwardTaxable.taxable, 0, t31.outwardTaxable.cgst, t31.outwardTaxable.sgst, tot(t31.outwardTaxable)],
      ["(b) Outward zero-rated supplies", 0, 0, 0, 0, 0],
      ["(c) Other outward supplies (Nil-rated, Exempted)", 0, 0, 0, 0, 0],
      ["(d) Inward supplies liable to RCM", t31.rcmLiability.taxable, t31.rcmLiability.igst, t31.rcmLiability.cgst, t31.rcmLiability.sgst, tot(t31.rcmLiability)],
      ["(e) Non-GST outward supplies", 0, 0, 0, 0, 0],
      ["Total Outward + RCM Liability", t31.total.taxable, t31.total.igst, t31.total.cgst, t31.total.sgst, tot(t31.total)],
      [],
      ["TABLE 4 - ITC", "", "IGST", "CGST", "SGST", "Total Tax"],
      ["(A) ITC Available"],
      ["  (1) Import of goods", "", 0, 0, 0, 0],
      ["  (2) Import of services", "", 0, 0, 0, 0],
      ["  (3) Inward supplies liable to RCM (matches Table 3.1(d))", "", t4.itcRcm.igst, t4.itcRcm.cgst, t4.itcRcm.sgst, tot(t4.itcRcm)],
      ["  (4) Inward supplies from ISD", "", 0, 0, 0, 0],
      ["  (5) All other ITC (from GSTR-2B Table 4(A)(5))", "", t4.itcOther.igst, t4.itcOther.cgst, t4.itcOther.sgst, tot(t4.itcOther)],
      ["Total (A) ITC Available", "", t4.totalAvailable.igst, t4.totalAvailable.cgst, t4.totalAvailable.sgst, tot(t4.totalAvailable)],
      ["(B) ITC Reversed (Rule 42/43, Rule 37A, Rule 38)", "", t4.reversed.igst, t4.reversed.cgst, t4.reversed.sgst, tot(t4.reversed)],
      ["(C) Net ITC Available  =  (A) - (B)", "", t4.net.igst, t4.net.cgst, t4.net.sgst, tot(t4.net)],
      ["(D) Other Details (Ineligible u/s 17(5), ITC reclaimed)", "", 0, 0, 0, 0],
      [],
      ["TABLE 5 - EXEMPT/NIL/NON-GST INWARD SUPPLIES"],
      ["From a supplier under composition / exempt / nil rated / non-GST: NIL"],
      [],
      ["TABLE 6.1 - PAYMENT OF TAX", "Tax Liability", "ITC Used", "Tax Paid in Cash"],
      ["IGST", t61.igst.liability, t61.igst.itcUsed, t61.igst.cash],
      ["CGST", t61.cgst.liability, t61.cgst.itcUsed, t61.cgst.cash],
      ["SGST", t61.sgst.liability, t61.sgst.itcUsed, t61.sgst.cash],
      ["TOTAL", t61.igst.liability + t61.cgst.liability + t61.sgst.liability, t61.igst.itcUsed + t61.cgst.itcUsed + t61.sgst.itcUsed, t61.igst.cash + t61.cgst.cash + t61.sgst.cash],
      [],
      ["ITC OFFSET DETAIL (Rule 88A - IGST credit used first)"],
      ["  IGST ITC used for IGST liability", od.igstUsedForIgst],
      ["  IGST ITC cross-utilized to CGST (50% of surplus)", od.igstCrossToCgst],
      ["  IGST ITC cross-utilized to SGST (50% of surplus)", od.igstCrossToSgst],
      ["  CGST ITC used for CGST liability", od.cgstOwnUsed],
      ["  SGST ITC used for SGST liability", od.sgstOwnUsed],
      [],
      ["CASH CHALLAN BREAKUP", "IGST", "CGST", "SGST", "Total"],
      ["RCM Payable in Cash (mandatory)", cc.rcm.igst, cc.rcm.cgst, cc.rcm.sgst, cc.rcm.total],
      ["Regular Tax Payable (Outward residual after ITC)", cc.regular.igst, cc.regular.cgst, cc.regular.sgst, cc.regular.total],
      ["Late Fee", cc.lateFee, "", "", cc.lateFee],
      ["Interest", cc.interest, "", "", cc.interest],
      ["TOTAL CHALLAN AMOUNT", cc.total.igst, cc.total.cgst, cc.total.sgst, cc.total.grandTotal],
      [],
      ["GSTR-1 vs GSTR-3B RECONCILIATION", "Taxable", "IGST", "CGST", "SGST", "Total Tax"],
      ["GSTR-1 Filed Total (B2C, net)", p.total.taxable, 0, p.total.cgst, p.total.sgst, p.total.cgst + p.total.sgst],
      ["GSTR-3B Table 3.1(a) Outward Taxable", t31.outwardTaxable.taxable, 0, t31.outwardTaxable.cgst, t31.outwardTaxable.sgst, tot(t31.outwardTaxable)],
      ["Difference (must be NIL)", p.total.taxable - t31.outwardTaxable.taxable, 0, p.total.cgst - t31.outwardTaxable.cgst, p.total.sgst - t31.outwardTaxable.sgst, (p.total.cgst + p.total.sgst) - tot(t31.outwardTaxable)],
      [],
      ["NOTES & METHODOLOGY"],
      ["1. All B2C sales are intra-state (Karnataka) -> CGST + SGST @ 9% each (18% total). No IGST."],
      ["2. ITC from GSTR-2B (Table 4(A)(5))."],
      ["3. RCM tax is paid in CASH (Section 49(4) / 2(82) of CGST Act - cannot be set off via ITC)."],
      ["4. RCM tax paid becomes ITC in the same period (Table 4(A)(3))."],
      ["5. IGST ITC must be fully utilized before CGST/SGST credits (Rule 88A) - split 50:50."],
    ], { title: [0, 1, 2, 3], header: [5, 12, 25, 38, 47], total: [11, 20, 29, 43, 49], colW: [52, 16, 16, 16, 16, 16] });
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
