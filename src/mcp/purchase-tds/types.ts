/**
 * Purchase/Vendor TDS classifier — types.
 * Implements InnovFin-Purchase-TDS-Classification-Spec.md (194C / 194J / 194I / 194H on inbound
 * vendor invoices). The classifier STRUCTURE is app-agnostic; the tax rules (SAC→section, rates,
 * codes, thresholds) live in config.ts and are ⚠ PENDING SHOYAB/CA — nothing is locked for filing.
 */

/** The TDS sections this classifier can emit (spec §2). Not tds-core's `Section` — that master only
 *  encodes the filing-validated 194C/194H/194J; here we carry the finer purchase split as strings. */
export type PurchaseSection =
  | "194C"        // advertising / contract — 1% non-company, 2% company (via tds-core)
  | "194J(a)"     // technical services — 2%
  | "194J(b)"     // professional / legal / accounting — 10%
  | "194I(a)"     // rent of plant & machinery — 2%
  | "194I(b)"     // rent of land/building — 10%
  | "194H"        // commission / brokerage — 2% (usually the Gateway MCP's job; here = route to review)
  | "NONE";       // pure goods → no purchase-side TDS

export type ClassificationBasis = "vendor-override" | "sac" | "keyword" | "unknown";

/** An accepted invoice reduced to the fields TDS classification needs (from the Invoice MCP canonical record). */
export interface PurchaseInvoice {
  docId?: string;
  invoiceNumber: string | null;
  vendorName: string | null;
  vendorGstin: string | null;
  hsnSac: string | null;        // ONE header SAC (per-line not captured yet — see spec §1 note)
  taxableValue: number | null;  // EXCL GST — the TDS base (spec §9). GST is never taxed.
  total: number | null;         // incl GST — fallback/display only
  invoiceDate: string | null;   // YYYY-MM-DD — for annual threshold aggregation
  description?: string | null;  // subject/body/text — keyword fallback only
}

export interface Classification {
  section: PurchaseSection | null;   // null = couldn't classify → review
  basis: ClassificationBasis;
  confidence: number;                // 0..1
  needsReview: boolean;
  flags: string[];
}

/** One classified + rated invoice — the spec §9 output contract. */
export interface PurchaseTdsLine {
  docId?: string;
  invoiceNumber: string | null;
  vendorName: string | null;
  vendorGstin: string | null;
  deducteePan: string | null;
  entityType: string;                // from tds-core (INDIVIDUAL/COMPANY/…/UNKNOWN)
  section: PurchaseSection | null;
  newCode: string | null;            // challan deposit code — null when unconfirmed (never guessed)
  majorHead: "0020" | "0021" | null; // COMPANY → 0020, else 0021
  rate: number | null;               // effective rate (null when not classified / not computable)
  taxableValue: number | null;       // EXCL GST
  tds: number | null;                // rate × taxableValue
  classificationBasis: ClassificationBasis;
  confidence: number;
  needsReview: boolean;
  belowThreshold: boolean;           // classified but under the §6 limit (no deduction yet)
  flags: string[];
}
