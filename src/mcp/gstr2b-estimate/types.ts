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

/** One charge row parsed from an invoice's line-item table (see line-items.ts). `charge` is the
 *  taxable fee for the row; `amountTransacted` is the underlying transaction volume and is NOT
 *  taxable. `category` is the invoice's own section grouping (e.g. Cashfree PAYOUT / PAYMENT GATEWAY). */
export interface InvoiceLineItem {
  category: string | null;
  description: string;
  hsnSac: string;
  gstRatePct: number;
  quantity: number;
  amountTransacted: number;
  charge: number;
}

/** Per-category subtotal of the line charges. */
export interface LineItemCategory {
  category: string;
  lines: number;
  charge: number;
}

/** The per-line composition of an invoice's taxable value, surfaced on each itc_invoices line so a
 *  reader sees WHERE the taxable (and hence the CGST/SGST/IGST) comes from — not just the totals. */
export interface LineItemBreakdown {
  source: string;                       // which parser produced it, e.g. "cashfree-tax-invoice"
  count: number;
  items: InvoiceLineItem[];
  byCategory: LineItemCategory[];
  taxableFromLines: number;             // Σ charge — should tie back to the invoice's taxable value
  reconcilesToTaxable: boolean | null;  // Σ charge ≈ taxableValue (±₹1); null when taxable unknown
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
  /** Per-line charge composition parsed from the invoice text; null when the format isn't parsed. */
  lineItems?: LineItemBreakdown | null;
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
  /** Where the taxable value comes from — per-service charge rows; null when not parseable. */
  lineItems?: LineItemBreakdown | null;
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
    /** `totalInclGst` is RUPEES ONLY; foreign-currency rows are kept apart, never summed in. */
    needsReviewPending: { count: number; totalInclGst: number; foreignInclGst: Record<string, number> } | null;
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
/** One portal supplier, and how much of what they filed we actually hold. */
export interface SupplierCoverage {
  gstin: string;
  supplierName: string | null;
  /** Rank by 2B ITC, 1 = largest. */
  rank: number;
  invoices2b: number;
  taxable2b: number;
  itc2b: number;
  /** Share of the period's total 2B ITC, and the running total down the ranking. */
  sharePct: number;
  cumulativePct: number;
  capturedInvoices: number;
  capturedItc: number;
  missingItc: number;
  status: "captured" | "partial" | "missing";
  /** The specific invoices to go and collect, largest first. */
  missingInvoices: Array<{ invoiceNo: string; invoiceDate: string | null; taxable: number; itc: number }>;
  /** >0 when `missingInvoices` was capped — never a silent truncation. */
  missingInvoicesNotShown: number;
}

/** "Capture this supplier too → coverage becomes X%" — the ranked what-if. */
export interface CoverageScenario {
  label: string;
  addsItc: number;
  cumulativeItc: number;
  coveragePct: number;
}

/**
 * How much of the month's REAL ITC the estimate is seeing, and what it would take to see the rest.
 *
 * The estimate can only ever be as good as the mailbox: a supplier who never emails an invoice is
 * invisible to it until the portal 2B lands. This turns that blind spot into a ranked worklist —
 * who filed, how much of it we hold, and which single supplier is worth chasing next.
 */
export interface ItcCoverage {
  portalItcTotal: number;
  capturedItc: number;
  missingItc: number;
  coveragePct: number;
  suppliers2b: number;
  /** Suppliers ranked by 2B ITC — the concentration view. */
  suppliers: SupplierCoverage[];
  /** Baseline first, then each uncaptured supplier in rank order. */
  scenarios: CoverageScenario[];
  /** Everything past the last scenario, so the ranking always sums back to 100%. */
  tail: { suppliers: number; itc: number; sharePct: number };
}

export interface EstimateVsActual {
  basis: string;
  period: string;
  periodLabel: string;
  receivedTo: string | null;
  /** Coverage — the "are we even seeing our own invoices?" view. */
  coverage: ItcCoverage;
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
