import * as XLSX from "xlsx-js-style";
import type { Gstr3bResult } from "@/gst-core/gstr3b";

const CYAN = "A6D8EC";   // section / header bands
const GREEN = "C6E0B4";  // total rows
const HEADTXT = "1F3864"; // dark navy header text
const MONEY_FMT = '#,##0.00;-#,##0.00;"-"';
const THIN = { style: "thin", color: { rgb: "808080" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

type CellStyle = Record<string, unknown>;
function setStyle(ws: XLSX.WorkSheet, r: number, c: number, s: CellStyle): void {
  const ref = XLSX.utils.encode_cell({ r, c });
  const cell = ws[ref] as (XLSX.CellObject & { s?: CellStyle }) | undefined;
  if (cell) cell.s = s;
  else (ws as Record<string, unknown>)[ref] = { t: "s", v: "", s };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]}-${y}`;
}

/** Due date = 20th of the month after the return period. */
function dueDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  let ny = y, nm = (m || 1) + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `20-${MONTHS[nm - 1]}-${ny}`;
}

const tot = (t: { igst: number; cgst: number; sgst: number }) => t.igst + t.cgst + t.sgst;

/**
 * Build the final GSTR-3B report workbook in Innovfix's filed "Summary" format:
 * Table 3.1 → Table 4 (ITC) → Table 6.1 (payment) → Rule 88A offset → cash challan breakup.
 */
export function buildGstr3bWorkbook(g3: Gstr3bResult): Buffer {
  const { table31: t31, table4: t4, table61: t61, offsetDetail: od, cashChallan: cc } = g3;

  const rows: (string | number)[][] = [
    ["Innovfix Private Limited"],
    ["GSTIN - 29AAICI1603A1Z3"],
    [`GSTR-3B Working - Period: ${periodLabel(g3.period)}`],
    [`Due date: ${dueDate(g3.period)}`],
    [],
    ["TABLE 3.1 - OUTWARD SUPPLIES", "Taxable Value", "IGST", "CGST", "SGST", "Total Tax"],
    ["(a) Outward taxable supplies (B2C)", t31.outwardTaxable.taxable, t31.outwardTaxable.igst, t31.outwardTaxable.cgst, t31.outwardTaxable.sgst, tot(t31.outwardTaxable)],
    ["(b) Outward zero-rated", t31.zeroRated.taxable, 0, 0, 0, 0],
    ["(c) Other outward (nil/exempt)", t31.otherOutward.taxable, 0, 0, 0, 0],
    ["(d) Inward liable to RCM", t31.rcmLiability.taxable, t31.rcmLiability.igst, t31.rcmLiability.cgst, t31.rcmLiability.sgst, tot(t31.rcmLiability)],
    ["(e) Non-GST outward", t31.nonGst.taxable, 0, 0, 0, 0],
    ["Total Outward + RCM Liability", t31.total.taxable, t31.total.igst, t31.total.cgst, t31.total.sgst, tot(t31.total)],
    [],
    ["TABLE 4 - ITC", "", "IGST", "CGST", "SGST", "Total Tax"],
    ["(A)(1) Import of goods", "", 0, 0, 0, 0],
    ["(A)(2) Import of services", "", 0, 0, 0, 0],
    ["(A)(3) Inward liable to RCM", "", t4.itcRcm.igst, t4.itcRcm.cgst, t4.itcRcm.sgst, tot(t4.itcRcm)],
    ["(A)(4) Inward from ISD", "", 0, 0, 0, 0],
    ["(A)(5) All other ITC (GSTR-2B)", "", t4.itcOther.igst, t4.itcOther.cgst, t4.itcOther.sgst, tot(t4.itcOther)],
    ["Total (A) ITC Available", "", t4.totalAvailable.igst, t4.totalAvailable.cgst, t4.totalAvailable.sgst, tot(t4.totalAvailable)],
    ["(B) ITC Reversed", "", t4.reversed.igst, t4.reversed.cgst, t4.reversed.sgst, tot(t4.reversed)],
    ["(C) Net ITC Available", "", t4.net.igst, t4.net.cgst, t4.net.sgst, tot(t4.net)],
    ["(D) Ineligible ITC", "", 0, 0, 0, 0],
    [],
    ["TABLE 6.1 - PAYMENT OF TAX", "Tax Liability", "ITC Used", "Cash Payable"],
    ["IGST", t61.igst.liability, t61.igst.itcUsed, t61.igst.cash],
    ["CGST", t61.cgst.liability, t61.cgst.itcUsed, t61.cgst.cash],
    ["SGST", t61.sgst.liability, t61.sgst.itcUsed, t61.sgst.cash],
    ["TOTAL", t61.igst.liability + t61.cgst.liability + t61.sgst.liability, t61.igst.itcUsed + t61.cgst.itcUsed + t61.sgst.itcUsed, t61.igst.cash + t61.cgst.cash + t61.sgst.cash],
    [],
    ["ITC OFFSET DETAIL (Rule 88A)"],
    ["  IGST ITC used for IGST", od.igstUsedForIgst],
    ["  IGST ITC cross-utilized to CGST", od.igstCrossToCgst],
    ["  IGST ITC cross-utilized to SGST", od.igstCrossToSgst],
    ["  CGST ITC used for CGST", od.cgstOwnUsed],
    ["  SGST ITC used for SGST", od.sgstOwnUsed],
    [],
    ["CASH CHALLAN BREAKUP", "IGST", "CGST", "SGST", "Total"],
    ["RCM Payable in Cash (mandatory)", cc.rcm.igst, cc.rcm.cgst, cc.rcm.sgst, cc.rcm.total],
    ["Regular Tax Payable (after ITC)", cc.regular.igst, cc.regular.cgst, cc.regular.sgst, cc.regular.total],
    ["Late Fee", "", "", "", cc.lateFee],
    ["Interest", "", "", "", cc.interest],
    ["TOTAL CHALLAN", cc.total.igst, cc.total.cgst, cc.total.sgst, cc.total.grandTotal],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 40 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];

  // Style: cyan section/header bands, green totals, borders + comma/2-dp numbers (zeros → "–").
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const label = String(row[0] ?? "").trim();
    const isTitle = r <= 3;
    const isSection = /^(TABLE\b|ITC OFFSET|CASH CHALLAN)/i.test(label);
    const isTotal = /^total\b/i.test(label);
    for (let c = 0; c < row.length; c++) {
      const isNum = typeof row[c] === "number";
      let s: CellStyle;
      if (isTitle) {
        s = { font: { bold: true, sz: r === 0 ? 14 : 10, color: { rgb: r === 0 ? HEADTXT : "595959" } } };
      } else if (isSection) {
        s = { font: { bold: true, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, border: BORDER, alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center", wrapText: true } };
      } else if (isTotal) {
        s = { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREEN } }, border: { ...BORDER, top: { style: "medium", color: { rgb: "548235" } } }, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } };
        if (isNum) s.numFmt = MONEY_FMT;
      } else {
        s = { border: BORDER, alignment: { vertical: "center", horizontal: isNum ? "right" : "left" } };
        if (isNum) s.numFmt = MONEY_FMT;
      }
      setStyle(ws, r, c, s);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "GSTR-3B Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
