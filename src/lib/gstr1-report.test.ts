import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildGstr1Workbook } from "./gstr1-report";
import { toLine, summarise, type Gstr1Line } from "@/gst-core/gstr1";

describe("buildGstr1Workbook", () => {
  it("produces a GSTR-1 Summary sheet in the filed format (per-app rows + total)", () => {
    const lines: Gstr1Line[] = [
      toLine("Hima", { taxable: 1000, invoiceValueActual: 1180, count: 5, serialMin: 1, serialMax: 5, basis: "" }),
      toLine("Sudar", { taxable: 200, invoiceValueActual: 236, count: 2, serialMin: null, serialMax: null, basis: "" }),
    ];
    const { total } = summarise(lines);
    const buf = buildGstr1Workbook("2026-05", lines, total);

    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toContain("GSTR-1 Summary");
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets["GSTR-1 Summary"], { header: 1 }) as unknown[][];
    const flat = aoa.map((r) => (r || []).join("|"));

    expect(flat.some((r) => r.includes("B2C Sales for May 2026 - GSTR-1 Calculation"))).toBe(true);
    expect(flat.some((r) => r.includes("Taxable Value") && r.includes("Rounded Off Invoice Value"))).toBe(true);
    expect(flat.some((r) => r.startsWith("Hima"))).toBe(true);
    expect(flat.some((r) => r.startsWith("Total"))).toBe(true);
    expect(flat.some((r) => r.includes("Payment Gateways"))).toBe(true);
  });
});
