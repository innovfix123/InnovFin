import * as XLSX from "xlsx-js-style";
import type { Gstr1Line, Gstr1Total } from "@/gst-core/gstr1";

/**
 * GSTR-1 working workbook in Innovfix's filed "B2C Sales … GSTR-1 Calculation" format,
 * styled to match Shoyab's manual sheet: a cyan title banner + header row, green data +
 * total rows, cell borders, comma/2-dp number formats, and zeros shown as "–".
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

const HEADERS = [
  "Application", "Taxable Value", "IGST", "CGST", "SGST", "Invoice Value", "Round Off",
  "Rounded Off Invoice Value", "B2C HSN", "Service Summary", "Serial Number Starting",
  "Serial Number Ending", "Total Invoices", "Cancelled Invoices", "Remaining Invoices", "Remarks",
];

const COLS = HEADERS.length;
const MONEY_FMT = '#,##0.00;-#,##0.00;"-"'; // positive ; negative ; zero → dash
const COUNT_FMT = "#,##0";
const MONEY_COLS = new Set([1, 2, 3, 4, 5, 6, 7]);
const COUNT_COLS = new Set([12, 13, 14]);

const CYAN = "A6D8EC";   // title banner + header row
const GREEN = "C6E0B4";  // data + total rows
const HEADTXT = "1F3864"; // dark navy header text
const THIN = { style: "thin", color: { rgb: "808080" } };
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

type Style = Record<string, unknown>;
function setStyle(ws: XLSX.WorkSheet, r: number, c: number, s: Style): void {
  const ref = XLSX.utils.encode_cell({ r, c });
  const cell = ws[ref] as (XLSX.CellObject & { s?: Style }) | undefined;
  if (cell) cell.s = s;
  else (ws as Record<string, unknown>)[ref] = { t: "s", v: "", s };
}

export function buildGstr1Workbook(period: string, lines: Gstr1Line[], total: Gstr1Total): Buffer {
  const rows: (string | number)[][] = [
    ["Innovfix Private Limited"],
    ["GSTIN - 29AAICI1603A1Z3"],
    [`B2C Sales for ${periodLabel(period)} - GSTR-1 Calculation`],
    [],
    HEADERS,
  ];
  for (const l of lines) {
    rows.push([
      l.app, r2(l.taxable), r2(l.igst ?? 0), r2(l.cgst), r2(l.sgst),
      r2(l.invoiceValueCalc), r2(l.roundOff), r2(l.invoiceValueActual),
      l.hsn ?? "", l.service ?? "",
      l.serialMin ?? "", l.serialMax ?? "", l.count, 0, l.count, "",
    ]);
  }
  rows.push([
    "Total", r2(total.taxable), r2(total.igst), r2(total.cgst), r2(total.sgst),
    r2(total.invoiceValueCalc), r2(total.roundOff), r2(total.invoiceValueActual),
    "", "", "", "", total.count, 0, total.count, "",
  ]);
  rows.push([], ["Payment Gateways"],
    ["Hima — PhonePe, Cashfree"],
    ["Sudar — Razorpay"],
    ["Only Care — Cashfree"],
    ["Unman — Razorpay"],
  );

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 18 }, { wch: 16 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 },
    { wch: 20 }, { wch: 10 }, { wch: 52 }, { wch: 16 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 28 },
  ];

  const headerRow = 4;
  const dataStart = 5;
  const dataEnd = 5 + lines.length - 1;
  const totalRow = dataEnd + 1;
  const gwHeaderRow = totalRow + 2;

  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: COLS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: COLS - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: COLS - 1 } },
  ];

  // Title block
  setStyle(ws, 0, 0, { font: { bold: true, sz: 15, color: { rgb: HEADTXT } } });
  setStyle(ws, 1, 0, { font: { bold: true, sz: 10, color: { rgb: "595959" } } });
  for (let c = 0; c < COLS; c++) {
    setStyle(ws, 2, c, { font: { bold: true, sz: 13, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, alignment: { horizontal: "center", vertical: "center" }, border: BORDER });
  }

  // Header row (cyan)
  for (let c = 0; c < COLS; c++) {
    setStyle(ws, headerRow, c, { font: { bold: true, sz: 10, color: { rgb: HEADTXT } }, fill: { patternType: "solid", fgColor: { rgb: CYAN } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: BORDER });
  }

  // Data rows (green)
  for (let r = dataStart; r <= dataEnd; r++) {
    for (let c = 0; c < COLS; c++) {
      const s: Style = { fill: { patternType: "solid", fgColor: { rgb: GREEN } }, border: BORDER, alignment: { vertical: "center" } };
      if (c === 0) s.font = { bold: true };
      if (MONEY_COLS.has(c)) { s.numFmt = MONEY_FMT; s.alignment = { horizontal: "right", vertical: "center" }; }
      else if (COUNT_COLS.has(c)) { s.numFmt = COUNT_FMT; s.alignment = { horizontal: "right", vertical: "center" }; }
      else if (c === 8 || c === 10 || c === 11) s.alignment = { horizontal: "center", vertical: "center" };
      setStyle(ws, r, c, s);
    }
  }

  // Total row (green, bold, medium top border)
  for (let c = 0; c < COLS; c++) {
    const s: Style = { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREEN } }, border: { ...BORDER, top: { style: "medium", color: { rgb: "548235" } } }, alignment: { vertical: "center" } };
    if (MONEY_COLS.has(c)) { s.numFmt = MONEY_FMT; s.alignment = { horizontal: "right", vertical: "center" }; }
    else if (COUNT_COLS.has(c)) { s.numFmt = COUNT_FMT; s.alignment = { horizontal: "right", vertical: "center" }; }
    setStyle(ws, totalRow, c, s);
  }

  // Payment Gateways header
  setStyle(ws, gwHeaderRow, 0, { font: { bold: true, sz: 11, color: { rgb: HEADTXT } } });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "GSTR-1 Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
