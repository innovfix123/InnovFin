import { describe, it, expect } from "vitest";
import { POST } from "./route";

function csvFile(content: string, name: string): File {
  return new File([content], name, { type: "text/csv" });
}

describe("POST /api/gstr1 (handler)", () => {
  it("computes a GSTR-1 working from uploaded reports", async () => {
    const fd = new FormData();
    fd.set("period", "2026-05");
    fd.set(
      "file:Bangalore Connect",
      csvFile("Transaction Status,Transaction Amount\nSUCCESS,118\nFAILED,9999\nSUCCESS,236\n", "bc.csv"),
    );
    fd.set("type:Bangalore Connect", "phonepe");
    fd.set(
      "file:Sudar",
      csvFile("entity_id,type,amount\npay_1,payment,118\nsetl,settlement,5000\n", "sudar.csv"),
    );
    fd.set("type:Sudar", "razorpay");

    const req = new Request("http://localhost/api/gstr1", { method: "POST", body: fd });
    const res = await POST(req);
    const json = await res.json();

    expect(Object.keys(json.errors)).toHaveLength(0);
    expect(json.lines).toHaveLength(2);
    // BC: (118+236)/1.18 = 300 ; Sudar: 118/1.18 = 100 ; total taxable = 400
    expect(json.total.taxable).toBeCloseTo(400, 2);
    // intra-state: CGST = SGST = 9% of taxable
    expect(json.total.cgst).toBeCloseTo(36, 2);
    expect(json.total.sgst).toBeCloseTo(36, 2);
  });
});
