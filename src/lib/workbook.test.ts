import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { bufferToAOA, sheetNames } from "./workbook";
import { parse, r2 } from "@/gst-core/gstr1";

function makeXlsx(aoa: (string | number)[][], sheet = "Sheet1"): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("bufferToAOA + engine (real xlsx round-trip)", () => {
  it("reads an xlsx buffer to AOA and parses a Razorpay export", () => {
    const buf = makeXlsx([
      ["entity_id", "type", "amount"],
      ["pay_1", "payment", 118],
      ["pay_2", "payment", 236],
      ["setl_1", "settlement", 99999],
      ["pay_3", "refund", 50],
    ]);
    const aoa = bufferToAOA(buf);
    const m = parse("razorpay", aoa);
    expect(m.count).toBe(2);
    expect(r2(m.taxable)).toBe(300);
  });

  it("parses a CSV buffer too (SheetJS auto-detects)", () => {
    const csv = "Transaction Status,Transaction Amount\nSUCCESS,118\nFAILED,5000\nSUCCESS,236\n";
    const m = parse("phonepe", bufferToAOA(Buffer.from(csv, "utf8")));
    expect(m.count).toBe(2);
    expect(r2(m.taxable)).toBe(300);
  });

  it("lists sheet names", () => {
    expect(sheetNames(makeXlsx([["a"]], "MyTab"))).toContain("MyTab");
  });
});
