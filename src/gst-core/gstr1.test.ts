import { describe, it, expect } from "vitest";
import {
  num, r2, parse, toLine, summarise, APP_DEFAULTS, APP_ORDER, GST_RATE,
  type AOA, type Measurement,
} from "./gstr1";

const meas = (taxable: number, invoiceValueActual: number): Measurement => ({
  taxable, invoiceValueActual, count: 1, serialMin: null, serialMax: null, basis: "",
});

describe("num()", () => {
  it("strips commas, spaces and ₹", () => {
    expect(num("1,234.56")).toBe(1234.56);
    expect(num("₹ 299")).toBe(299);
    expect(num(" 1 000 ")).toBe(1000);
    expect(num(299)).toBe(299);
  });
  it("returns NaN for empty/blank/non-numeric", () => {
    expect(num("")).toBeNaN();
    expect(num(null)).toBeNaN();
    expect(num(undefined)).toBeNaN();
    expect(num("abc")).toBeNaN();
  });
});

describe("r2()", () => {
  it("rounds to 2 decimals (₹299 → taxable 253.39, cgst 22.81)", () => {
    expect(r2(253.389830508)).toBe(253.39);
    expect(r2(22.80508)).toBe(22.81);
    expect(r2(100)).toBe(100);
  });
});

describe("parse('invoicewise')", () => {
  it("sums Taxable Value, skips junk rows above the header, tracks serials", () => {
    const aoa: AOA = [
      ["Innovfix — Hima sales export"],
      ["generated 2026-06-01"],
      ["Invoice No", "Taxable Value", "Invoice Value"],
      ["1", "100", "118"],
      ["2", "200", "236"],
      ["", "", ""],
    ];
    const m = parse("invoicewise", aoa);
    expect(r2(m.taxable)).toBe(300);
    expect(r2(m.invoiceValueActual)).toBe(354);
    expect(m.count).toBe(2);
    expect(m.serialMin).toBe(1);
    expect(m.serialMax).toBe(2);
  });
  it("falls back to taxable*1.18 when there is no invoice value column", () => {
    const m = parse("invoicewise", [["Taxable Value"], ["1000"]]);
    expect(r2(m.taxable)).toBe(1000);
    expect(r2(m.invoiceValueActual)).toBe(1180);
  });
});

describe("parse('razorpay')", () => {
  it("keeps TYPE=payment only and divides gross amount by 1.18", () => {
    const aoa: AOA = [
      ["entity_id", "type", "amount"],
      ["pay_1", "payment", "118"],
      ["pay_2", "payment", "236"],
      ["setl_1", "settlement", "100000"],
      ["pay_3", "refund", "50"],
    ];
    const m = parse("razorpay", aoa);
    expect(m.count).toBe(2);
    expect(r2(m.invoiceValueActual)).toBe(354);
    expect(r2(m.taxable)).toBe(300);
  });
});

describe("parse('phonepe')", () => {
  it("keeps Transaction Status=SUCCESS only", () => {
    const aoa: AOA = [
      ["Transaction Status", "Transaction Amount"],
      ["SUCCESS", "118"],
      ["FAILED", "5000"],
      ["SUCCESS", "236"],
      ["PENDING", "70"],
    ];
    const m = parse("phonepe", aoa);
    expect(m.count).toBe(2);
    expect(r2(m.invoiceValueActual)).toBe(354);
    expect(r2(m.taxable)).toBe(300);
  });
});

describe("parse('cashfree')", () => {
  it("keeps SUCCESS only and sums Amount", () => {
    const aoa: AOA = [
      ["Order Id", "Amount", "Transaction Status"],
      ["o1", "118", "SUCCESS"],
      ["o2", "5000", "FAILED"],
      ["o3", "236", "SUCCESS"],
    ];
    const m = parse("cashfree", aoa);
    expect(m.count).toBe(2);
    expect(r2(m.taxable)).toBe(300);
  });
});

describe("toLine()", () => {
  it("computes CGST=SGST=9% of taxable, IGST=0, applies the app's HSN", () => {
    const line = toLine("Hima", meas(299 / 1.18, 299));
    expect(r2(line.taxable)).toBe(253.39);
    expect(r2(line.cgst)).toBe(22.81);
    expect(r2(line.sgst)).toBe(22.81);
    expect(line.igst).toBe(0);
    expect(line.hsn).toBe(998439);
    expect(line.roundOff).toBeCloseTo(0, 6);
  });
  it("allows HSN/service override per upload", () => {
    const line = toLine("Hima", meas(100, 118), { hsn: 111111, service: "custom" });
    expect(line.hsn).toBe(111111);
    expect(line.service).toBe("custom");
  });
});

describe("summarise()", () => {
  it("groups by HSN (Table 12) and ties out to the per-app total", () => {
    const lines = [
      toLine("Hima", meas(1000, 1180)),       // HSN 998439
      toLine("Only Care", meas(500, 590)),    // HSN 998439
      toLine("Sudar", meas(200, 236)),        // HSN 999299
    ];
    const { hsnRows, total } = summarise(lines);
    expect(r2(total.taxable)).toBe(1700);
    expect(r2(total.cgst)).toBe(r2(1700 * 0.09));
    const h998439 = hsnRows.find((r) => String(r.hsn) === "998439");
    expect(h998439 && r2(h998439.taxable)).toBe(1500);
    const hsnSum = hsnRows.reduce((a, r) => a + r.taxable, 0);
    expect(Math.abs(hsnSum - total.taxable)).toBeLessThan(1e-6); // tie-out
  });
});

describe("app config (matches the validated code, not the transcript)", () => {
  it("has 6 apps; Unman defaults to invoicewise; HSNs are correct", () => {
    expect(APP_ORDER.length).toBe(6);
    expect(APP_DEFAULTS["Unman"].type).toBe("invoicewise");
    expect(APP_DEFAULTS["Thedal"].hsn).toBe(998433);
    expect(APP_DEFAULTS["Bangalore Connect"].hsn).toBe(998599);
    expect(APP_DEFAULTS["Sudar"].hsn).toBe(999299);
    expect(GST_RATE).toBe(0.18);
  });
});
