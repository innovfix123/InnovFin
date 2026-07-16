/**
 * Estimated GSTR-2B / ITC — the ITC-ELIGIBILITY CONFIG.
 *
 * ⚠ FIRST-DRAFT, PENDING SHOYAB/CA (same contract as purchase-tds/config.ts). Which Section 17(5)
 * categories are blocked for Innovfix and which inbound categories fall under reverse charge is
 * finance judgment — every list below is a configurable input to be confirmed before anyone treats
 * the headline estimate as claimable ITC. The engine (compute.ts) is judgment-free: a match here
 * only FLAGS a line into the review bucket — nothing is auto-included and nothing is silently
 * dropped. Edit these lists without touching logic.
 */
import { OWN_PAN } from "@/tds-core";

/** Innovfix's home state code (GSTIN prefix 29 = Karnataka). Intra-state vendors charge CGST+SGST,
 *  inter-state vendors charge IGST — the HEAD_MISMATCH review flag checks that consistency. */
export const HOME_STATE_CODE = "29";

/** Standard 15-char GSTIN (the same shape src/lib/gstr2b.ts uses to spot B2B rows). Non-resident /
 *  OIDAR registrations (e.g. 9924USA29003OSI) intentionally fail this — they surface as INVALID_GSTIN. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

/** True when a GSTIN belongs to Innovfix itself (any state registration of our PAN) — the classic
 *  extraction error where the buyer GSTIN lands in vendor_gstin. */
export function isOwnGstin(gstin: string): boolean {
  return gstin.length === 15 && gstin.slice(2, 12).toUpperCase() === OWN_PAN;
}

export interface EligibilityRule {
  match: string; // SAC/HSN prefix, or lowercase vendor-name substring
  label: string;
}

export interface EligibilityRules {
  /** SAC/HSN prefixes suspected blocked under Section 17(5). Prefix match on fields.hsn_sac. */
  blockedSacPrefixes: EligibilityRule[];
  /** Vendor-name keywords suspected blocked under 17(5) (the registry captures no line description yet). */
  blockedKeywords: EligibilityRule[];
  /** SAC prefixes of reverse-charge-notified inbound categories. */
  rcmSacPrefixes: EligibilityRule[];
  /** Vendor-name keywords of RCM-notified categories. */
  rcmKeywords: EligibilityRule[];
}

/**
 * ⚠ Seed lists only — Shoyab confirms/extends which categories actually apply to Innovfix.
 * A hit routes the line to review with the label below; it never excludes or includes by itself.
 * (The June CA working already carries "Foreign Payments - RCM" and "Rent RCM" sheets — foreign
 * currency is flagged by compute.ts directly; unregistered-landlord rent surfaces via NO_GSTIN.)
 */
export const ELIGIBILITY_RULES: EligibilityRules = {
  blockedSacPrefixes: [
    { match: "99633", label: "catering / food & beverages — 17(5)(b)" },
    { match: "9964", label: "passenger transport — 17(5)(a)/(b)" },
    { match: "9966", label: "rental of road vehicles — 17(5)(a)/(b)" },
    { match: "9954", label: "works contract / construction — 17(5)(c)/(d)" },
  ],
  blockedKeywords: [
    { match: "restaurant", label: "food & beverages — 17(5)(b)" },
    { match: "catering", label: "food & beverages — 17(5)(b)" },
    { match: "caterer", label: "food & beverages — 17(5)(b)" },
    { match: "club", label: "club membership — 17(5)(b)" },
    { match: "gym", label: "health & fitness — 17(5)(b)" },
    { match: "fitness", label: "health & fitness — 17(5)(b)" },
    { match: "insurance", label: "life/health insurance — 17(5)(b); plain asset insurance is fine, review" },
    { match: "cab", label: "rent-a-cab / passenger transport — 17(5)(b)" },
    { match: "taxi", label: "rent-a-cab / passenger transport — 17(5)(b)" },
  ],
  rcmSacPrefixes: [
    { match: "9965", label: "goods transport (GTA) — RCM 9(3)" },
    { match: "9967", label: "goods transport support — RCM 9(3)" },
  ],
  rcmKeywords: [
    { match: "advocate", label: "legal services by advocate — RCM 9(3)" },
    { match: "legal", label: "legal services — RCM 9(3) if by an advocate/firm of advocates" },
    { match: "sponsor", label: "sponsorship — RCM 9(3)" },
    { match: "freight", label: "goods transport (GTA) — RCM 9(3)" },
    { match: "transport", label: "goods transport (GTA) — RCM 9(3)" },
    { match: "logistics", label: "goods transport (GTA) — RCM 9(3)" },
  ],
};
