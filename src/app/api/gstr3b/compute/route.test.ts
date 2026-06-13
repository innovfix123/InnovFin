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

  it("classifies a raw RCM expense list, hits ₹52,52,218.18, and reconciles", async () => {
    const body = {
      period: "2026-04",
      outward: { taxable: 51061813.11, cgst: 4595563.18, sgst: 4595563.18 },
      rcmExpenses: [
        { vendor: "Agora Payment", amount: 1503893 }, { vendor: "Digital Ocean", amount: 186211 },
        { vendor: "Higgsfield", amount: 158956 }, { vendor: "Claude AI", amount: 139448 },
        { vendor: "Cursor AI", amount: 68722 }, { vendor: "OpenRouter", amount: 19806 },
        { vendor: "Slack", amount: 10868 }, { vendor: "Agora Onlycare", amount: 9432 },
        { vendor: "Hostinger", amount: 8701 }, { vendor: "Google Play", amount: 8024 },
        { vendor: "Chatgpt", amount: 5245 }, { vendor: "Lamdatest", amount: 4508 },
        { vendor: "Manus AI", amount: 3917 }, { vendor: "Wondershare", amount: 3566 },
        { vendor: "Googleplay", amount: 3268 }, { vendor: "Anthropic", amount: 3256 },
        { vendor: "Freepik", amount: 3000 }, { vendor: "Elevenlabs", amount: 1936 },
        { vendor: "Canva", amount: 1300 }, { vendor: "OpenAI", amount: 931 },
        { vendor: "Rent JP (Tipiverse Hospitality)", amount: 75000 }, { vendor: "Yuvanesh Rent", amount: 14000 },
        { vendor: "Ayush Rent (B V Srinivas)", amount: 13500 }, { vendor: "Tamil Rent", amount: 11000 },
      ],
      itc2b: { taxable: 21898928.96, igst: 3698718.48, cgst: 120094.85, sgst: 120094.85 },
    };
    const res = await POST(
      new Request("http://localhost/api/gstr3b/compute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const json = await res.json();
    expect(json.cashChallan.total.grandTotal).toBeCloseTo(5252218.18, 2);
    expect(json.rcmReport.review).toHaveLength(0); // all April vendors recognised
    expect(json.rcmReport.excluded.map((l: { vendor: string }) => l.vendor)).toContain("Tamil Rent");
    expect(json.reconciliation.gstr1Vs3b.ok).toBe(true);
    expect(json.reconciliation.internal.ok).toBe(true);
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
