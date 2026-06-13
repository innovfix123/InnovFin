/**
 * RCM (Reverse Charge Mechanism) classification & computation — GSTR-3B Table 3.1(d).
 *
 * Ported 1:1 from the validated "GST Workings Master Reference" and the April 2026
 * workings (Foreign Payments - RCM + Rent RCM tabs). DO NOT change the rules or
 * arithmetic without re-validating against a filed month (April 2026 = ₹3,86,097.84
 * IGST + ₹9,225/₹9,225 CGST/SGST).
 *
 * Pure functions over a plain expense list, so identical in the browser, the Next.js
 * server, and tests. The standing vendor rules below are management-approved; a NEW
 * vendor not matched here is returned as "review" (never silently counted).
 *
 * Two buckets (Master Reference §4.2):
 *   (A) Foreign / import of services  -> IGST @ 18%, tax ADDED on top (INR paid = taxable, Rule 34)
 *   (B) Rent from unregistered landlord -> CGST 9% + SGST 9%, tax added on top (Sec 9(4))
 */

export const RCM_IGST_RATE = 0.18; // foreign import of services
export const RCM_CGST_RATE = 0.09; // rent (unregistered landlord)
export const RCM_SGST_RATE = 0.09;

export type RcmCategory = "foreign" | "rent" | "exclude" | "review";

export interface RcmExpense {
  /** Expense Categorisation / vendor tag, exactly as it appears in the bank pivot. */
  vendor: string;
  /** Total INR paid in the month (gateway/bank pivot value). */
  amount: number;
  incharge?: string;
  status?: string;
}

export interface RcmClassified extends RcmExpense {
  category: RcmCategory;
  /** Rupee-rounded taxable contribution (0 for exclude/review). */
  taxable: number;
  reason: string;
}

export interface RcmResult {
  foreign: { taxable: number; igst: number; lines: RcmClassified[] };
  rent: { taxable: number; cgst: number; sgst: number; lines: RcmClassified[] };
  excluded: RcmClassified[];
  /** Unknown vendors — needs a human (or LLM-assisted) call before filing. */
  review: RcmClassified[];
  /** GSTR-3B Table 3.1(d) totals. */
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  /** RCM is always paid in CASH (Sec 49(4)/2(82)); it returns as ITC the same month. */
  cashPayable: number;
}

/* ----------------------------------------------------------------------------
 * Standing rules — from the GST Workings Master Reference (April 2026 validated).
 * Match is case-insensitive substring on the normalised vendor name. Order of
 * precedence: EXCLUDE first (so "Tamil Rent" never falls into RENT), then RENT,
 * then FOREIGN, else "review".
 * -------------------------------------------------------------------------- */

/** Always EXCLUDE from RCM (management decision / registered landlord / personal). */
const EXCLUDE_KEYS = [
  "apple media",   // historically excluded by management
  "oh dear",       // historically excluded
  "tamil rent",    // INIYA HOME PG — employee personal accommodation, lease in employee name
  "iniya home",
  "incubex",       // registered landlord — GST in GSTR-2B as B2B, not RCM
];

/** Rent from unregistered landlords -> CGST 9% + SGST 9%. */
const RENT_KEYS = [
  "rent jp",
  "tipiverse",
  "yuvanesh rent",
  "ayush rent",
  "b v srinivas",
];

/** Foreign vendors / import of services -> IGST 18%. */
const FOREIGN_KEYS = [
  "agora", "digital ocean", "digitalocean", "higgsfield", "claude", "anthropic",
  "cursor", "openrouter", "slack", "hostinger", "google play", "googleplay",
  "chatgpt", "openai", "lambdatest", "lamdatest", "manus", "wondershare",
  "freepik", "elevenlabs", "canva",
];

function norm(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Round to nearest rupee (the validated workings round each line, then sum). */
function rupee(n: number): number {
  return Math.round(n);
}

/** Classify a single vendor by the standing rules. Unknown -> "review". */
export function classifyVendor(vendor: string): { category: RcmCategory; reason: string } {
  const n = norm(vendor);
  if (!n) return { category: "review", reason: "empty vendor name" };
  const hit = (keys: string[]) => keys.find((k) => n.includes(k));
  let k: string | undefined;
  if ((k = hit(EXCLUDE_KEYS))) return { category: "exclude", reason: `standing exclusion ("${k}")` };
  if ((k = hit(RENT_KEYS))) return { category: "rent", reason: `unregistered landlord ("${k}") — Sec 9(4)` };
  if ((k = hit(FOREIGN_KEYS))) return { category: "foreign", reason: `import of services ("${k}") — Sec 5(3)/(4)` };
  return { category: "review", reason: "unknown vendor — classify before filing" };
}

/**
 * Classify an expense list and compute Table 3.1(d). Foreign and rent taxables are
 * the rupee-rounded INR paid; tax is added on top. Excluded/review lines carry no tax.
 */
export function computeRcm(expenses: RcmExpense[]): RcmResult {
  const foreignLines: RcmClassified[] = [];
  const rentLines: RcmClassified[] = [];
  const excluded: RcmClassified[] = [];
  const review: RcmClassified[] = [];

  for (const e of expenses) {
    const { category, reason } = classifyVendor(e.vendor);
    const taxable = category === "foreign" || category === "rent" ? rupee(e.amount) : 0;
    const line: RcmClassified = { ...e, category, taxable, reason };
    if (category === "foreign") foreignLines.push(line);
    else if (category === "rent") rentLines.push(line);
    else if (category === "exclude") excluded.push(line);
    else review.push(line);
  }

  const foreignTaxable = foreignLines.reduce((a, l) => a + l.taxable, 0);
  const rentTaxable = rentLines.reduce((a, l) => a + l.taxable, 0);
  const igst = foreignTaxable * RCM_IGST_RATE;
  const cgst = rentTaxable * RCM_CGST_RATE;
  const sgst = rentTaxable * RCM_SGST_RATE;

  return {
    foreign: { taxable: foreignTaxable, igst, lines: foreignLines },
    rent: { taxable: rentTaxable, cgst, sgst, lines: rentLines },
    excluded,
    review,
    taxable: foreignTaxable + rentTaxable,
    igst,
    cgst,
    sgst,
    cashPayable: igst + cgst + sgst,
  };
}
