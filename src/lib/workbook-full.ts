import * as XLSX from "xlsx-js-style";
import type { AOA, Gstr1Line, Gstr1Total } from "@/gst-core/gstr1";
import type { Gstr3bResult } from "@/gst-core/gstr3b";
import type { RcmResult } from "@/gst-core/rcm";
import type { Gstr2bResult } from "@/lib/gstr2b";

/**
 * Assemble the full multi-sheet "GST Working" workbook — the equivalent of Shoyab's manual
 * file: a Final WORKINGS master, the GSTR-1 summary, each app's raw transaction dump, the
 * RCM (foreign/rent) tabs, the GSTR-2B summary + B2B, and the GSTR-3B summary — all styled
 * (cyan header bands, green totals, borders, comma/2-dp numbers).
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const periodLabel = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[(m || 1) - 1]} ${y}`; };

const CYAN = "A6D8EC", GREEN = "C6E0B4", HEADTXT = "1F3864";
const MONEY_FMT = '#,##0.00;-#,##0.00;"-"';
const THIN = { style: "thin", color: { rgb: "808080" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

type Style = Record<string, unknown>;
function set(ws: XLSX.WorkSheet, r: number, c: number, s: Style): void {
  const ref = XLSX.utils.encode_cell({ r, c });
  const cell = ws[ref] as (XLSX.CellObject & { s?: Style }) | undefined;
  if (cell) cell.s = s; else (ws as Record<string, unknown>)[ref] = { t: "s", v: "", s };
}
const tot = (t: { igst: number; cgst: number; sgst: number }) => t.igst + t.cgst + t.sgst;

/** A small, fully-styled summary sheet: titleRows bold, headerRows cyan, totalRows green, data bordered + money-formatted. */
function addSummarySheet(wb: XLSX.WorkBook, name: string, rows: (string | number)[][], o: { title?: number[]; header?: number[]; total?: number[] }): void {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const cols = Math.max(1, ...rows.map((r) => r?.length ?? 0));
  ws["!cols"] = Array.from({ length: cols }, (_, c) => ({ wch: c === 0 ? 34 : 16 }));
  const title = new Set(o.title ?? []), header = new Set(o.header ?? []), total = new Set(o.total ?? []);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.length === 0) continue;
    for (let c = 0; c < row.length; c++) {
      const isNum = typeof row[c] === "number";
      let s: Style;
      if (title.has(r)) s = { font: { bold: true, sz: r === 0 ? 14 : 11, color: { rgb: r === 0 ? HEADTXT : "595959" } } };
      else if (header.has(r)) s = { font: { bold: true, sz: 10, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, border: BORDER, alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center", wrapText: true } };
      else if (total.has(r)) { s = { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREEN } }, border: { ...BORDER, top: { style: "medium", color: { rgb: "548235" } } }, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } }; if (isNum) s.numFmt = MONEY_FMT; }
      else { s = { border: BORDER, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } }; if (isNum) s.numFmt = MONEY_FMT; }
      set(ws, r, c, s);
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

/** A raw transaction dump (large): style only the header row (fast), leave data plain. */
function addRawSheet(wb: XLSX.WorkBook, name: string, aoa: AOA): void {
  const data = aoa.length ? aoa : [["(no transactions)"]];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const cols = Math.max(1, data[0]?.length ?? 1);
  ws["!cols"] = Array.from({ length: cols }, () => ({ wch: 20 }));
  ws["!freeze"] = { xSplit: 0, ySplit: 1 } as unknown as XLSX.WorkSheet["!freeze"];
  for (let c = 0; c < cols; c++) set(ws, 0, c, { font: { bold: true, sz: 10, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, border: BORDER, alignment: { horizontal: "center", vertical: "center" } });
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

export interface FullWorkbookParts {
  period: string;
  lines: Gstr1Line[];
  total: Gstr1Total;
  gstr3b: Gstr3bResult;
  perApp: { app: string; aoa: AOA }[];
  rcm?: RcmResult | null;
  twoB?: Gstr2bResult | null;
}

export function buildFullWorkbook(p: FullWorkbookParts): Buffer {
  const wb = XLSX.utils.book_new();
  const g3 = p.gstr3b, t31 = g3.table31, t4 = g3.table4, t61 = g3.table61, cc = g3.cashChallan;
  const pl = periodLabel(p.period);

  // 1) Final WORKINGS — master GSTR-3B
  addSummarySheet(wb, "Final WORKINGS", [
    ["Innovfix Private Limited"],
    ["GSTIN - 29AAICI1603A1Z3"],
    [`Period: ${pl}`],
    [],
    ["OUTWARD SUPPLIES", "Taxable", "IGST", "CGST", "SGST", "Total Tax"],
    ["(a) Outward taxable (B2C)", t31.outwardTaxable.taxable, t31.outwardTaxable.igst, t31.outwardTaxable.cgst, t31.outwardTaxable.sgst, tot(t31.outwardTaxable)],
    ["(d) Inward liable to RCM", t31.rcmLiability.taxable, t31.rcmLiability.igst, t31.rcmLiability.cgst, t31.rcmLiability.sgst, tot(t31.rcmLiability)],
    ["Total Outward + RCM", t31.total.taxable, t31.total.igst, t31.total.cgst, t31.total.sgst, tot(t31.total)],
    [],
    ["INPUT TAX CREDIT", "", "IGST", "CGST", "SGST", "Total"],
    ["4(A)(5) GSTR-2B", "", t4.itcOther.igst, t4.itcOther.cgst, t4.itcOther.sgst, tot(t4.itcOther)],
    ["4(A)(3) RCM", "", t4.itcRcm.igst, t4.itcRcm.cgst, t4.itcRcm.sgst, tot(t4.itcRcm)],
    ["Net ITC available", "", t4.net.igst, t4.net.cgst, t4.net.sgst, tot(t4.net)],
    [],
    ["TAX PAYMENT (6.1)", "Liability", "ITC Used", "Cash"],
    ["IGST", t61.igst.liability, t61.igst.itcUsed, t61.igst.cash],
    ["CGST", t61.cgst.liability, t61.cgst.itcUsed, t61.cgst.cash],
    ["SGST", t61.sgst.liability, t61.sgst.itcUsed, t61.sgst.cash],
    ["TOTAL CASH CHALLAN", cc.total.igst + 0, "", cc.total.grandTotal],
  ], { title: [0, 1, 2], header: [4, 9, 14], total: [7, 12, 18] });

  // 2) GSTR-1 Summary
  const g1rows: (string | number)[][] = [
    ["Innovfix Private Limited"], ["GSTIN - 29AAICI1603A1Z3"], [`B2C Sales for ${pl} - GSTR-1 Calculation`], [],
    ["Application", "Taxable Value", "IGST", "CGST", "SGST", "Invoice Value", "Round Off", "B2C HSN", "Service Summary", "Total Invoices"],
  ];
  for (const l of p.lines) g1rows.push([l.app, l.taxable, l.igst ?? 0, l.cgst, l.sgst, l.invoiceValueCalc, l.roundOff, l.hsn ?? "", l.service ?? "", l.count]);
  g1rows.push(["Total", p.total.taxable, p.total.igst, p.total.cgst, p.total.sgst, p.total.invoiceValueCalc, p.total.roundOff, "", "", p.total.count]);
  addSummarySheet(wb, "GSTR-1 Summary", g1rows, { title: [0, 1, 2], header: [4], total: [g1rows.length - 1] });

  // 3) Per-app raw transaction dumps
  for (const { app, aoa } of p.perApp) addRawSheet(wb, `${app} Sales`, aoa);

  // 4) RCM — Foreign + Rent
  const fLines = p.rcm?.foreign.lines ?? [];
  const foreignRows: (string | number)[][] = [["Foreign Payments — RCM (IGST 18%)"], [], ["Vendor", "Taxable (₹ paid)", "IGST"]];
  for (const l of fLines) foreignRows.push([l.vendor, l.taxable, l.taxable * 0.18]);
  foreignRows.push(["Total", p.rcm?.foreign.taxable ?? g3.table31.rcmLiability.taxable, p.rcm?.foreign.igst ?? g3.table31.rcmLiability.igst]);
  addSummarySheet(wb, "Foreign Payments - RCM", foreignRows, { title: [0], header: [2], total: [foreignRows.length - 1] });

  const rLines = p.rcm?.rent.lines ?? [];
  const rentRows: (string | number)[][] = [["Rent RCM — unregistered landlord (CGST+SGST 9%)"], [], ["Vendor", "Taxable", "CGST", "SGST"]];
  for (const l of rLines) rentRows.push([l.vendor, l.taxable, l.taxable * 0.09, l.taxable * 0.09]);
  rentRows.push(["Total", p.rcm?.rent.taxable ?? 0, p.rcm?.rent.cgst ?? g3.table31.rcmLiability.cgst, p.rcm?.rent.sgst ?? g3.table31.rcmLiability.sgst]);
  addSummarySheet(wb, "Rent RCM", rentRows, { title: [0], header: [2], total: [rentRows.length - 1] });

  // 5) GSTR-2B summary + B2B detail
  const itc = p.twoB?.itcAvailable ?? { igst: t4.itcOther.igst, cgst: t4.itcOther.cgst, sgst: t4.itcOther.sgst, taxable: 0 };
  addSummarySheet(wb, "GSTR-2B Summary", [
    [`GSTR-2B — ${pl}`], [],
    ["Heading", "Taxable", "IGST", "CGST", "SGST"],
    ["4(A)(5) All other ITC", itc.taxable, itc.igst, itc.cgst, itc.sgst],
    ["4(B) ITC reversed", "", p.twoB?.itcReversed.igst ?? 0, p.twoB?.itcReversed.cgst ?? 0, p.twoB?.itcReversed.sgst ?? 0],
    ["4(D) Ineligible", "", p.twoB?.itcIneligible.igst ?? 0, p.twoB?.itcIneligible.cgst ?? 0, p.twoB?.itcIneligible.sgst ?? 0],
  ], { title: [0], header: [2], total: [3] });

  if (p.twoB?.invoices.length) {
    const b2b: (string | number)[][] = [["GSTIN", "Invoice No", "Taxable", "IGST", "CGST", "SGST"]];
    for (const i of p.twoB.invoices) b2b.push([i.gstin, i.invoiceNo, i.taxable, i.igst, i.cgst, i.sgst]);
    addRawSheet(wb, "GSTR-2B - B2B", b2b);
  }

  // 6) GSTR-3B Summary
  addSummarySheet(wb, "GSTR-3B Summary", [
    ["Innovfix Private Limited"], ["GSTIN - 29AAICI1603A1Z3"], [`GSTR-3B — ${pl} · Due ${MONTHS[(Number(p.period.split("-")[1]) % 12)]}-20`], [],
    ["CASH CHALLAN", "IGST", "CGST", "SGST", "Total"],
    ["RCM (mandatory cash)", cc.rcm.igst, cc.rcm.cgst, cc.rcm.sgst, cc.rcm.total],
    ["Regular (after ITC)", cc.regular.igst, cc.regular.cgst, cc.regular.sgst, cc.regular.total],
    ["TOTAL CHALLAN", cc.total.igst, cc.total.cgst, cc.total.sgst, cc.total.grandTotal],
  ], { title: [0, 1, 2], header: [4], total: [7] });

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
