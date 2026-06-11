import { describe, it, expect } from "vitest";
import { POST } from "./route";

const april = {
  period: "2026-04",
  outward: { taxable: 51061813.11, cgst: 4595563.18, sgst: 4595563.18 },
  rcm: { foreign: { taxable: 2144988, igst: 386097.84 }, rent: { taxable: 102500, cgst: 9225, sgst: 9225 } },
  itc2b: { taxable: 21898928.96, igst: 3698718.48, cgst: 120094.85, sgst: 120094.85 },
};

describe("POST /api/gstr3b/compute", () => {
  it("returns the April challan ₹52,52,218.18", async () => {
    const res = await POST(
      new Request("http://localhost/api/gstr3b/compute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(april),
      }),
    );
    const json = await res.json();
    expect(json.cashChallan.total.grandTotal).toBeCloseTo(5252218.18, 2);
  });

  it("rejects malformed input with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/gstr3b/compute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
