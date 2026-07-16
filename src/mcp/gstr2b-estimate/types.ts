/**
 * Estimated GSTR-2B / ITC MCP — types.
 *
 * Everything this MCP emits is an ESTIMATE: the input-tax credit Innovfix should EXPECT for a
 * period, computed from vendor invoices already in hand (accepted rows of the invoice-intelligence
 * registry) — NOT the filed GSTR-2B, which GSTN generates on the 14th from what suppliers actually
 * filed. Once the portal workbook exists, itc_reconcile holds the two against each other, reusing
 * src/lib/gstr2b.ts (parse) and src/gst-core/reconcile.ts (books↔2B matcher) as-is.
 */
import type { PurchaseInvoice } from "@/gst-core/reconcile";

/** The GST heads ITC accrues under. The 2B summary sheet reports igst/cgst/sgst; cess is carried
 *  in the estimate and called out separately in the reconciliation (the summary-row parse has no cess). */
export interface ItcHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** One vendor invoice mapped out of the registry's canonical document. GST amounts exist only when
 *  the extractor found them (see invoice-intelligence/fields/models.py CANONICAL_FIELDS). */
export interface RegistryInvoice {
  docId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;  // YYYY-MM-DD — buckets the invoice into a 2B period
  receivedDate: string | null; // when the mail arrived — the point-in-time (received_to) axis
  vendorName: string | null;
  vendorGstin: string | null;
  buyerGstin: string | null;
  currency: string | null;     // null → INR assumed
  taxableValue: number | null; // excl-GST value, when extracted
  igst: number | null;
  cgst: number | null;
  sgst: number | null;
  cess: number | null;
  total: number | null;        // incl-GST — display/sanity only
  hsnSac: string | null;
  sender: string | null;
}

/** Why a line routes to the review bucket instead of the headline estimate. */
export type FlagCode =
  | "NO_GSTIN"         // no vendor GSTIN — no B2B ITC path (unregistered supplier may mean RCM)
  | "INVALID_GSTIN"    // malformed, or a non-resident/OIDAR (99…) registration
  | "OWN_GSTIN"        // vendor GSTIN is an Innovfix registration — extraction grabbed the buyer
  | "BUYER_MISMATCH"   // billed to a GSTIN that is not Innovfix's
  | "FOREIGN_CURRENCY" // import of service — RCM; never appears in 2B B2B
  | "NO_TAX_BREAKUP"   // no CGST/SGST/IGST extracted — nothing to count yet
  | "HEAD_MISMATCH"    // charged heads don't fit vendor state vs 29-Karnataka
  | "BLOCKED_17_5"     // Section 17(5) blocked-credit suspect (⚠ rules pending Shoyab)
  | "RCM_SUSPECT"      // reverse-charge-notified category suspect (⚠ rules pending Shoyab)
  | "NO_DATE";         // no invoice date — cannot place in a 2B period

export interface EligibilityFlag {
  code: FlagCode;
  detail: string;
}

/** One evaluated invoice: its ITC as extracted (zeros when unknown) + which bucket it landed in. */
export interface EstimateLine {
  docId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  vendorName: string | null;
  vendorGstin: string | null;
  hsnSac: string | null;
  currency: string | null;
  taxableValue: number | null;
  total: number | null;
  itc: ItcHeads;
  itcTotal: number;
  /** true → counted in the headline estimate; false → review bucket (see flags). */
  included: boolean;
  flags: EligibilityFlag[];
}

/** Per-vendor (GSTIN) roll-up of the headline estimate. */
export interface VendorRollup {
  gstin: string;
  vendorName: string | null;
  invoices: number;
  taxable: number;
  itc: ItcHeads;
  itcTotal: number;
}

/** Compact review-bucket line for the aggregate payload (full lines live in itc_invoices). */
export interface ReviewLineSummary {
  docId: string;
  vendorName: string | null;
  vendorGstin: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  total: number | null;
  itcTotal: number;
  flags: string[]; // "CODE — detail"
}

/** The itc_estimate payload. */
export interface ItcEstimate {
  basis: string;           // the ESTIMATE label — every payload carries it
  eligibilityNote: string; // the ⚠ pending-Shoyab disclaimer
  period: string;
  periodLabel: string;
  receivedTo: string | null; // point-in-time cut-off, when supplied
  registry: {
    acceptedFetched: number; // accepted rows considered (after the received_to cut)
    inPeriod: number;        // dated inside the period
    undated: number;         // no invoice_date → review bucket (NO_DATE)
    outOfPeriod: number;     // dated another month → not this period's estimate
    needsReviewPending: { count: number; totalInclGst: number } | null;
  };
  estimate: {
    invoices: number;
    vendors: number;
    taxable: number;
    itc: ItcHeads;
    itcTotal: number;
    byVendor: VendorRollup[];
  };
  underReview: {
    invoices: number;
    /** ITC on flagged lines AS EXTRACTED — potential additional credit if review clears them. */
    potentialItc: ItcHeads;
    potentialItcTotal: number;
    byFlag: Record<string, number>;
    lines: ReviewLineSummary[];
  };
  caveats: string[];
}

/** itc_reconcile payload — the estimate held against the ACTUAL portal GSTR-2B. */
export interface EstimateVsActual {
  basis: string;
  period: string;
  periodLabel: string;
  receivedTo: string | null;
  headline: {
    /** ESTIMATE side — headline (clean) ITC from invoices in hand. */
    estimate: ItcHeads & { total: number; invoices: number };
    /** ESTIMATE + review bucket as extracted — the upper bound if review clears everything. */
    estimateWithReview: ItcHeads & { total: number; invoices: number };
    /** ACTUAL side — the portal 2B "ITC Available" 4(A)(5) row + its B2B invoice count. */
    actual2b: { igst: number; cgst: number; sgst: number; taxable: number; invoices: number; total: number };
    /** actual2b − estimate per head (positive → the 2B carries more than the clean estimate). */
    diff: { igst: number; cgst: number; sgst: number; total: number };
    ok: boolean; // heads match within the paise tolerance
  };
  invoiceMatch: {
    matched: number;
    matchedWithTaxDiff: Array<{ key: string; taxDiff: number }>;
    /** In hand but missing from the 2B → the supplier hasn't filed it; ITC at risk — chase. */
    inBooksNotIn2b: PurchaseInvoice[];
    /** In the 2B but not in the registry → never hit invoices@ — book it. */
    in2bNotInBooks: PurchaseInvoice[];
    ok: boolean;
  };
  /** Registry lines that couldn't join the GSTIN+number match at all. */
  excludedFromMatch: Array<{ docId: string; vendorName: string | null; reason: string }>;
  actual2bExtras: {
    itcReversed: { igst: number; cgst: number; sgst: number };
    itcIneligible: { igst: number; cgst: number; sgst: number };
  };
  caveats: string[];
}
