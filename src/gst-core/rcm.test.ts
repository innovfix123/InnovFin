import { describe, it, expect } from "vitest";
import { r2 } from "./gstr1";
import { computeRcm, classifyVendor, type RcmExpense } from "./rcm";

/**
 * The validated April 2026 RCM workings (Foreign Payments - RCM + Rent RCM tabs).
 * Target Table 3.1(d): Foreign ₹21,44,988 → IGST ₹3,86,097.84; Rent ₹1,02,500 →
 * CGST ₹9,225 + SGST ₹9,225 (Tamil Rent ₹11,000 EXCLUDED). RCM cash = ₹4,04,547.84.
 */
const APRIL_FOREIGN: RcmExpense[] = [
  { vendor: "Agora Payment", amount: 1503893 },
  { vendor: "Digital Ocean", amount: 186211 },
  { vendor: "Higgsfield", amount: 158956 },
  { vendor: "Claude AI", amount: 139448 },
  { vendor: "Cursor AI", amount: 68722 },
  { vendor: "OpenRouter", amount: 19806 },
  { vendor: "Slack", amount: 10868 },
  { vendor: "Agora Onlycare", amount: 9432 },
  { vendor: "Hostinger", amount: 8701 },
  { vendor: "Google Play", amount: 8024 },
  { vendor: "Chatgpt", amount: 5245 },
  { vendor: "Lamdatest", amount: 4508 },
  { vendor: "Manus AI", amount: 3917 },
  { vendor: "Wondershare", amount: 3566 },
  { vendor: "Googleplay", amount: 3268 },
  { vendor: "Anthropic", amount: 3256 },
  { vendor: "Freepik", amount: 3000 },
  { vendor: "Elevenlabs", amount: 1936 },
  { vendor: "Canva", amount: 1300 },
  { vendor: "OpenAI", amount: 931 },
];

const APRIL_RENT: RcmExpense[] = [
  { vendor: "Rent JP (Tipiverse Hospitality)", amount: 75000 },
  { vendor: "Yuvanesh Rent", amount: 14000 },
  { vendor: "Ayush Rent (B V Srinivas)", amount: 13500 },
  { vendor: "Tamil Rent", amount: 11000 }, // EXCLUDED — personal accommodation
];

describe("RCM — April 2026 validation (Table 3.1(d))", () => {
  const res = computeRcm([...APRIL_FOREIGN, ...APRIL_RENT]);

  it("foreign import of services → IGST ₹3,86,097.84", () => {
    expect(res.foreign.taxable).toBe(2144988);
    expect(r2(res.foreign.igst)).toBe(386097.84);
    expect(res.foreign.lines).toHaveLength(20);
  });

  it("rent (unregistered) → CGST ₹9,225 + SGST ₹9,225, Tamil excluded", () => {
    expect(res.rent.taxable).toBe(102500); // 75000 + 14000 + 13500, NOT Tamil
    expect(r2(res.rent.cgst)).toBe(9225);
    expect(r2(res.rent.sgst)).toBe(9225);
    expect(res.excluded.map((l) => l.vendor)).toContain("Tamil Rent");
  });

  it("total RCM cash payable = ₹4,04,547.84 (paid in cash, returns as ITC)", () => {
    expect(r2(res.cashPayable)).toBe(404547.84);
    expect(r2(res.igst)).toBe(386097.84);
    expect(r2(res.cgst)).toBe(9225);
    expect(r2(res.sgst)).toBe(9225);
  });

  it("every April vendor is recognised — nothing left in the review queue", () => {
    expect(res.review).toHaveLength(0);
  });
});

describe("RCM — per-line rupee rounding reproduces the filed total from raw decimals", () => {
  it("raw bank decimals round per line to ₹21,44,988", () => {
    const raw: RcmExpense[] = [
      { vendor: "Agora Payment", amount: 1503893.21 },
      { vendor: "Digital Ocean", amount: 186210.67 },
      { vendor: "Higgsfield", amount: 158955.83 },
      { vendor: "Claude AI", amount: 139448.49 },
      { vendor: "Cursor AI", amount: 68722.35 },
      { vendor: "OpenRouter", amount: 19805.8 },
      { vendor: "Slack", amount: 10867.72 },
      { vendor: "Agora Onlycare", amount: 9432.13 },
      { vendor: "Hostinger", amount: 8700.82 },
      { vendor: "Google Play", amount: 8023.5 },
      { vendor: "Chatgpt", amount: 5244.69 },
      { vendor: "Lamdatest", amount: 4508 },
      { vendor: "Manus AI", amount: 3916.92 },
      { vendor: "Wondershare", amount: 3566.2 },
      { vendor: "Googleplay", amount: 3268 },
      { vendor: "Anthropic", amount: 3256.44 },
      { vendor: "Freepik", amount: 3000 },
      { vendor: "Elevenlabs", amount: 1936 },
      { vendor: "Canva", amount: 1300 },
      { vendor: "OpenAI", amount: 930.65 },
    ];
    const res = computeRcm(raw);
    expect(res.foreign.taxable).toBe(2144988);
    expect(r2(res.foreign.igst)).toBe(386097.84);
  });
});

describe("classifyVendor — standing rules & precedence", () => {
  it("excludes take precedence over rent (Tamil Rent → exclude, not rent)", () => {
    expect(classifyVendor("Tamil Rent").category).toBe("exclude");
    expect(classifyVendor("INCUBEX Office Rent").category).toBe("exclude");
    expect(classifyVendor("Apple Media Service").category).toBe("exclude");
  });
  it("known landlords → rent; known foreign vendors → foreign", () => {
    expect(classifyVendor("Yuvanesh Rent").category).toBe("rent");
    expect(classifyVendor("Rent JP (Tipiverse Hospitality)").category).toBe("rent");
    expect(classifyVendor("Anthropic").category).toBe("foreign");
    expect(classifyVendor("Googleplay").category).toBe("foreign");
    expect(classifyVendor("Google Play").category).toBe("foreign");
  });
  it("an unseen vendor → review (never silently counted)", () => {
    const res = computeRcm([{ vendor: "SomeNewSaaS Inc", amount: 5000 }]);
    expect(res.review).toHaveLength(1);
    expect(res.taxable).toBe(0);
    expect(res.cashPayable).toBe(0);
  });
});
