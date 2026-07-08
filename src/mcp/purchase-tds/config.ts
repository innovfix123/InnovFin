/**
 * Purchase/Vendor TDS — the TAX-RULE CONFIG (spec §2/§3/§5/§6/§8).
 *
 * ⚠ FIRST-DRAFT, PENDING SHOYAB/CA. Every SAC→section row, rate, challan code and threshold here is
 * a configurable input that finance validates — NOTHING is locked for filing until confirmed (spec
 * §10). The engine (classify.ts / compute.ts) is tax-judgment-free; all judgment lives in this file
 * so it can be edited without touching logic. `confirmed: true` marks the rows already validated
 * against a filed challan (194C non-company 1023, 194H 1006); everything else is ⚠ unconfirmed.
 */
import type { PurchaseSection } from "./types";

/** Section → effective rate + challan code. 194C's rate is entity-based and delegated to tds-core
 *  (validated, anchor-locked); the flat sections carry their rate here. `codeConfirmed` gates filing. */
export interface SectionRule {
  /** "entity_194C" → rate from tds-core.statutoryRate("194C", entity); "flat" → use `flatRate`. */
  rateKind: "entity_194C" | "flat";
  flatRate?: number;
  codeCompany: string | null;             // deposit code when deductee is a company (head 0020)
  codeNonCompany: string | null;          // deposit code otherwise (head 0021)
  codeCompanyConfirmed: boolean;          // ⚠ false → "confirm code with Shoyab", never file
  codeNonCompanyConfirmed: boolean;
  note: string;
}

export const SECTION_RULES: Record<PurchaseSection, SectionRule> = {
  // 194C: 1023 (non-company) is validated (tds-core + filed May); 1024 (company) is ⚠ unconfirmed.
  "194C":    { rateKind: "entity_194C", codeNonCompany: "1023", codeCompany: "1024", codeNonCompanyConfirmed: true, codeCompanyConfirmed: false, note: "1% ind/HUF · 2% company/firm (rate via tds-core)" },
  "194J(a)": { rateKind: "flat", flatRate: 0.02, codeNonCompany: "1026", codeCompany: "1026", codeNonCompanyConfirmed: false, codeCompanyConfirmed: false, note: "technical services 2% ⚠ code" },
  "194J(b)": { rateKind: "flat", flatRate: 0.10, codeNonCompany: "1027", codeCompany: "1027", codeNonCompanyConfirmed: false, codeCompanyConfirmed: false, note: "professional 10% ⚠ code" },
  "194I(a)": { rateKind: "flat", flatRate: 0.02, codeNonCompany: null, codeCompany: null, codeNonCompanyConfirmed: false, codeCompanyConfirmed: false, note: "rent plant/machinery 2% ⚠" },
  "194I(b)": { rateKind: "flat", flatRate: 0.10, codeNonCompany: "1009", codeCompany: "1009", codeNonCompanyConfirmed: false, codeCompanyConfirmed: false, note: "rent land/building 10% ⚠ code" },
  "194H":    { rateKind: "flat", flatRate: 0.02, codeNonCompany: null, codeCompany: "1006", codeNonCompanyConfirmed: false, codeCompanyConfirmed: true, note: "commission — usually the Gateway MCP; here → review to avoid double-count" },
  "NONE":    { rateKind: "flat", flatRate: 0, codeNonCompany: null, codeCompany: null, codeNonCompanyConfirmed: true, codeCompanyConfirmed: true, note: "pure goods — no purchase-side TDS" },
};

/** §2 SAC → section. Longest prefix wins. `ambiguous` = the 194C-vs-194J boundary risk (spec §6). */
export interface SacRule { prefix: string; section: PurchaseSection; ambiguous?: boolean; note: string }
export const SAC_SECTION_MAP: SacRule[] = [
  { prefix: "99836", section: "194C", note: "advertising services" },
  { prefix: "998313", section: "194J(a)", note: "IT consulting" },
  { prefix: "998314", section: "194J(a)", note: "IT technical" },
  { prefix: "997212", section: "194I(b)", note: "rental of immovable property" },
  { prefix: "9982", section: "194J(b)", note: "legal / accounting / professional" },
  { prefix: "9985", section: "194C", note: "support / contract services" },
  { prefix: "9973", section: "194I(a)", note: "leasing/rental of machinery" },
  { prefix: "9971", section: "194H", note: "commission / brokerage (part)" },
  // ⚠ 9983 spans advertising (99836 → 194C, matched above) AND engineering/technical → 194J(a).
  // Anything left in 9983 after the specific rows defaults to technical, but is flagged as boundary-risk.
  { prefix: "9983", section: "194J(a)", ambiguous: true, note: "9983 (part) technical — ⚠ spans advertising(99836)/technical, verify" },
];

/** §5 vendor overrides. A rule with no `when` always applies; multiple rules = per-service (spec §5) —
 *  disambiguated by SAC/keyword, and routed to review if none matches. PANs from the May workbook. */
export interface OverrideRule { section: PurchaseSection; when?: { sacPrefix?: string[]; keywords?: string[] }; note: string }
export interface VendorOverride { pan: string; name: string; rules: OverrideRule[]; flag?: string }
export const VENDOR_OVERRIDES: VendorOverride[] = [
  {
    pan: "AABCZ7555P", name: "Zocket",
    rules: [
      { section: "194C", when: { sacPrefix: ["99836", "9983"], keywords: ["ads", "advertis", "meta ads", "ad spend", "media"] }, note: "ad-spend lines" },
      { section: "194J(a)", when: { keywords: ["subscription", "subscript", "platform fee", "saas"] }, note: "subscription charges" },
    ],
  },
  { pan: "AALCP6782E", name: "Paysprint", rules: [{ section: "194J(a)", note: "OTP/verification services (also our PAN-verification provider)" }] },
  { pan: "AAGCD1543A", name: "Datagen", rules: [{ section: "194J(a)", note: "OTP verification" }] },
  { pan: "AANFC0897L", name: "CFO Angle", rules: [{ section: "194J(b)", note: "professional fees (also reviews our filing)" }] },
  { pan: "BWDPM9841H", name: "Produco", rules: [{ section: "194J(b)", note: "professional fees" }] },
  // ⚠ Scholiverse carries OUR PAN in the workbook (data error) → caught by the own-PAN guard, needs real PAN.
];

/** §3 keyword fallback (only when no usable SAC; ALWAYS routed to review). Precedence-ordered. */
export interface KeywordRule { section: PurchaseSection; words: string[] }
export const KEYWORD_RULES: KeywordRule[] = [
  { section: "194C", words: ["advertisement", "advertising", "ad spend", "media buying", "marketing services"] },
  { section: "194C", words: ["contract", "labour", "job work", "amc", "annual maintenance"] },
  { section: "194J(b)", words: ["professional fee", "consultancy", "legal", "audit", "accounting", "retainer"] },
  { section: "194J(a)", words: ["technical", "engineering", "software development", "otp", "verification service", "api"] },
  { section: "194H", words: ["commission", "brokerage", "processing fee", "gateway charge"] },
  { section: "194I(b)", words: ["rent", "lease", "hire"] },
];

/** §6 thresholds (₹). ⚠ confirm application with Shoyab. Annual = aggregate per vendor per FY. */
export const THRESHOLDS = {
  "194C": { perPayment: 30_000, annual: 100_000 },
  "194J(a)": { perPayment: 0, annual: 30_000 },
  "194J(b)": { perPayment: 0, annual: 30_000 },
  "194I(a)": { perPayment: 0, annual: 240_000 },
  "194I(b)": { perPayment: 0, annual: 240_000 },
  "194H": { perPayment: 0, annual: 20_000 },
  "NONE": { perPayment: 0, annual: 0 },
} as const;

/** §6 de-minimis: below this rupee TDS, ignore ("Nobroker – ignore less amount"). ⚠ confirm cutoff. */
export const DE_MINIMIS_TDS = 1;
