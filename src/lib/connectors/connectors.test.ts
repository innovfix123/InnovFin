import { describe, it, expect } from "vitest";
import { monthRange } from "./period";
import { mapRazorpayPayments } from "./razorpay";
import { mapCashfreeTxns } from "./cashfree";
import { razorpayConnector } from "./razorpay";

describe("monthRange (IST boundaries)", () => {
  it("spans IST 00:00 on the 1st to IST 23:59:59.999 on the last day", () => {
    const r = monthRange("2026-05");
    // IST 1-May 00:00 == UTC 30-Apr 18:30
    expect(new Date(r.fromMs).toISOString()).toBe("2026-04-30T18:30:00.000Z");
    // IST 31-May 23:59:59.999 == UTC 31-May 18:29:59.999
    expect(new Date(r.toMs).toISOString()).toBe("2026-05-31T18:29:59.999Z");
  });
  it("rejects a malformed period", () => {
    expect(() => monthRange("2026/05")).toThrow();
  });
});

describe("mapRazorpayPayments", () => {
  it("keeps only captured payments and converts paise → ₹", () => {
    const aoa = mapRazorpayPayments([
      { id: "pay_1", amount: 11800, status: "captured", created_at: 1 },
      { id: "pay_2", amount: 5000, status: "failed", created_at: 2 },
      { id: "pay_3", amount: 23600, status: "captured", created_at: 3 },
      { id: "pay_4", amount: 999, status: "authorized", created_at: 4 },
    ]);
    expect(aoa[0]).toEqual(["entity_id", "type", "amount", "status", "created_at"]);
    expect(aoa).toHaveLength(3); // header + 2 captured
    expect(aoa[1]).toEqual(["pay_1", "payment", 118, "captured", 1]);
    expect(aoa[2][2]).toBe(236);
  });
});

describe("mapCashfreeTxns", () => {
  it("builds the parser's header + rows (parser filters SUCCESS itself)", () => {
    const aoa = mapCashfreeTxns([
      { order_id: "o1", amount: 118, status: "SUCCESS" },
      { order_id: "o2", amount: 50, status: "FAILED" },
    ]);
    expect(aoa[0]).toEqual(["Order Id", "Amount", "Transaction Status"]);
    expect(aoa).toHaveLength(3);
  });
});

describe("connector config", () => {
  it("reports not-configured when no creds present", () => {
    const c = razorpayConnector("Sudar", undefined);
    expect(c.isConfigured()).toBe(false);
    expect(c.parserType).toBe("razorpay");
    expect(c.mode).toBe("auto");
  });
});
