import * as XLSX from "xlsx";
import type { AOA } from "@/gst-core/gstr1";

/**
 * Read an uploaded CSV/XLSX buffer into an array-of-arrays (AOA), using the exact
 * SheetJS options the validated web tool used, so parsing is byte-for-byte identical.
 * SheetJS auto-detects CSV vs XLSX, so this works for both.
 */
export function bufferToAOA(buf: Buffer | Uint8Array, sheetName?: string): AOA {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, raw: false });
  const name = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error("No worksheet found in the uploaded file.");
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null }) as AOA;
}

/** List the sheet names in a workbook (for the UI to let the user pick a tab). */
export function sheetNames(buf: Buffer | Uint8Array): string[] {
  const wb = XLSX.read(buf, { type: "buffer", bookSheets: true });
  return wb.SheetNames;
}
