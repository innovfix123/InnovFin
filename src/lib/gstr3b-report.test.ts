import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { computeGstr3b, type Gstr3bInput } from "@/gst-core/gstr3b";
import { buildGstr3bWorkbook } from "./gstr3b-report";

const april: Gstr3bInput = {
  period: "2026-04",
  outward: { taxable: 51061813.11, cgst: 4595563.18, sgst: 4595563.18 },
  rcm: { foreign: { taxable: 2144988, igst: 386097.84 }, rent: { taxable: 102500, cgst: 9225, sgst: 9225 } },
  itc2b: { taxable: 21898928.96, igst: 3698718.48, cgst: 120094.85, sgst: 120094.85 },
};

describe("buildGstr3bWorkbook", () => {
  it("produces a GSTR-3B Summary sheet ending at the ₹52,52,218.18 challan", () => {
    const buf = buildGstr3bWorkbook(computeGstr3b(april));
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toContain("GSTR-3B Summary");

    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["GSTR-3B Summary"], {
      header: 1,
      blankrows: false,
    });
    const totalRow = aoa.find((r) => String(r[0]).startsWith("TOTAL CHALLAN"));
    expect(totalRow).toBeTruthy();
    expect(Number(totalRow?.[4])).toBeCloseTo(5252218.18, 2);
  });
});
