/**
 * Sec_194C_NonCompany workbook emitter — the exact filed column contract, one row per payout
 * (matches the filed May sheet: 1,190 Onlycare rows). Uses xlsx-js-style, same infra family as GST.
 */
import * as XLSX from "xlsx-js-style";
import type { ComputedRow } from "./compute";
import { monthLabel, round2 } from "./util";

const HEADERS = [
  "Month", "TAN", "Challan Serial No.", "App Name", "Srl No.", "Creators name", "U/S", "PAN No",
  "Bill NO.", "Payment Date", "RATE", "BILL AMT", "Taxable Amt", "TDS", "Cess", "INT", "Total",
  "Status", "No of Transactions", "Cashfree Processing Fees", "Total Credited Amount",
];

function statusLabel(s: ComputedRow["status"]): string {
  return s === "OPERATIVE" ? "Operative" : s === "INOPERATIVE" ? "Inoperative" : "Unverified";
}

/** Build the Sec_194C_NonCompany xlsx as a Buffer. TAN/Challan left blank (back-filled post-deposit). */
export function buildSec194CNonCompany(period: string, rows: ComputedRow[]): Buffer {
  const month = monthLabel(period);
  const aoa: (string | number | null)[][] = [HEADERS];
  rows.forEach((r, i) => {
    const tds = round2(r.tdsDeposited);
    aoa.push([
      month, "", "", r.app, i + 1, r.creatorName ?? "", "194C", r.pan ?? "",
      "", r.paymentDate, r.rateApplied, "", round2(r.taxable), tds, 0, 0, tds,
      statusLabel(r.status), "", r.cashfreeFee ?? "", r.netCredited ?? "",
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = HEADERS.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sec_194C_NonCompany");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
