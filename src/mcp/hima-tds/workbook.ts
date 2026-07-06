/**
 * Sec_194C_NonCompany workbook emitter for Hima — the exact filed column contract, one row per
 * payout (App Name = "Hima"). Mirrors src/mcp/onlycare-tds/workbook.ts (same HEADERS / column
 * order / xlsx-js-style infra); kept per-app so the two anchors stay cleanly separated.
 * NB: "Cashfree Processing Fees" is cf_service_charge — NULL for May-2026 (a placeholder column).
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
