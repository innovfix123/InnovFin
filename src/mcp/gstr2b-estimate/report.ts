/**
 * The estimated-GSTR-2B REPORT — the month's estimate rendered as the finished breakdown finance
 * reads, not raw JSON for a caller to re-format.
 *
 * Why this lives server-side: the numbers are only half the deliverable. Which sections appear, in
 * what order, what gets called out as excluded, and — above all — that a USD receipt is never
 * printed with a ₹ sign, are part of being correct. Rendering here makes every "give me the June
 * estimate" answer identical, in any session, without depending on the caller to remember the
 * shape. The JSON payload is still returned alongside for anything that wants to compute on it.
 *
 * Pure: (estimate, lines) in → markdown out. No I/O, no formatting of anything it wasn't given.
 */
import type { EstimateLine, ItcEstimate, ItcHeads } from "./types";

/** "1 invoice" / "2 invoices" — the report is read by people, not parsed. */
const plural = (n: number, word: string, suffix = "s") => `${n} ${word}${n === 1 ? "" : suffix}`;

/** Indian-format money. `currency` other than INR prints its ISO code, never a rupee sign. */
export function money(n: number, currency = "INR"): string {
  const v = n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${v}` : `${currency} ${v}`;
}

const headsRows = (h: ItcHeads): string[] => [
  `| IGST | ${money(h.igst)} |`,
  `| CGST | ${money(h.cgst)} |`,
  `| SGST | ${money(h.sgst)} |`,
  `| Cess | ${money(h.cess)} |`,
];

/** Charge rows shown before the list is capped (with the remainder counted, never dropped). */
const MAX_CHARGE_ROWS = 15;
/** Review rows shown before the same treatment. */
const MAX_REVIEW_ROWS = 15;

function chargeSection(lines: EstimateLine[]): string[] {
  const withItems = lines.filter((l) => l.included && l.lineItems && l.lineItems.items.length > 0);
  if (withItems.length === 0) return [];

  const rows = withItems.flatMap((l) =>
    l.lineItems!.items.map((it) => ({ ...it, invoiceNumber: l.invoiceNumber })),
  ).sort((a, b) => b.charge - a.charge);

  const shown = rows.slice(0, MAX_CHARGE_ROWS);
  const out = [
    "",
    "## Charge-wise breakup",
    "",
    "| Description | HSN/SAC | GST% | Charge |",
    "|---|---|---:|---:|",
    ...shown.map((r) => {
      const exempt = r.gstRatePct === 0 ? " *(exempt)*" : "";
      return `| ${r.description}${exempt} | ${r.hsnSac} | ${r.gstRatePct}% | ${money(r.charge)} |`;
    }),
  ];
  if (rows.length > shown.length) {
    const rest = rows.slice(MAX_CHARGE_ROWS).reduce((a, r) => a + r.charge, 0);
    out.push(`| *…${rows.length - shown.length} more charge rows* | | | ${money(rest)} |`);
  }
  const total = rows.reduce((a, r) => a + r.charge, 0);
  out.push(`| **Total charges** | | | **${money(total)}** |`);

  // Tie-back: the charge rows must reconstruct the taxable value they were parsed out of.
  const ties = withItems.every((l) => l.lineItems!.reconcilesToTaxable !== false);
  out.push("", ties
    ? "*Charge rows reconcile to the invoice taxable value.*"
    : "⚠ *Charge rows do NOT reconcile to the invoice taxable value — check the invoice.*");
  return out;
}

function reviewSection(estimate: ItcEstimate, lines: EstimateLine[]): string[] {
  const review = lines.filter((l) => !l.included);
  if (review.length === 0) {
    return ["", "## Under review", "", "*Nothing excluded on eligibility grounds this period.*"];
  }
  const shown = review.slice(0, MAX_REVIEW_ROWS);
  const out = [
    "",
    `## Under review — excluded from the headline (${review.length})`,
    "",
    "| Invoice | Vendor GSTIN | Value | Potential ITC | Why excluded |",
    "|---|---|---:|---:|---|",
    ...shown.map((l) => {
      const ccy = (l.currency ?? "INR").toUpperCase();
      const value = l.total !== null ? money(l.total, ccy) : "—";
      const reasons = l.flags.map((f) => f.code).join(", ") || "—";
      return `| ${l.invoiceNumber ?? "—"} | ${l.vendorGstin ?? "—"} | ${value} | ${money(l.itcTotal)} | ${reasons} |`;
    }),
  ];
  if (review.length > shown.length) out.push(`| *…${review.length - shown.length} more* | | | | |`);
  out.push("", `**Potential additional ITC if review clears them: ${money(estimate.underReview.potentialItcTotal)}**`);
  return out;
}

/** Pending needs_review rows, per currency — never one fused number. */
function pendingLine(estimate: ItcEstimate): string[] {
  const nrp = estimate.registry.needsReviewPending;
  if (!nrp || nrp.count === 0) return [];
  const parts: string[] = [];
  const foreign = Object.entries(nrp.foreignInclGst ?? {});
  if (nrp.totalInclGst > 0 || foreign.length === 0) parts.push(money(nrp.totalInclGst));
  for (const [ccy, amt] of foreign) parts.push(money(amt, ccy));
  return ["", `**Not yet in the estimate:** ${plural(nrp.count, "invoice")} ≈ ${parts.join(" + ")} (incl. GST) ` +
             `${nrp.count === 1 ? "sits" : "sit"} unapproved in the review queue at /invoices.`];
}

/** Render the month's estimate as the finished markdown breakdown. */
export function renderEstimateReport(estimate: ItcEstimate, lines: EstimateLine[]): string {
  const e = estimate.estimate;
  const asOf = estimate.receivedTo ? ` · as of ${estimate.receivedTo}` : "";
  const invoiceValue = lines.filter((l) => l.included).reduce((a, l) => a + (l.total ?? 0), 0);

  const out = [
    `# Estimated GSTR-2B — ${estimate.periodLabel}`,
    `**Basis: vendor invoices in hand${asOf} · NOT the filed GSTR-2B**`,
    "",
    "## ITC Available",
    "",
    "| Head | Amount |",
    "|---|---:|",
    ...headsRows(e.itc),
    `| **Total ITC** | **${money(e.itcTotal)}** |`,
    "",
    `Taxable ${money(e.taxable)} · Invoice value ${money(invoiceValue)} · ` +
      `${plural(e.invoices, "invoice")} · ${plural(e.vendors, "vendor")}`,
  ];

  if (e.byVendor.length > 0) {
    out.push(
      "",
      "## Supplier-wise",
      "",
      "| Supplier | GSTIN | Inv | Taxable | IGST | CGST | SGST | ITC |",
      "|---|---|---:|---:|---:|---:|---:|---:|",
      ...e.byVendor.map((v) =>
        `| ${v.vendorName ?? "—"} | ${v.gstin} | ${v.invoices} | ${money(v.taxable)} | ` +
        `${money(v.itc.igst)} | ${money(v.itc.cgst)} | ${money(v.itc.sgst)} | **${money(v.itcTotal)}** |`),
    );
  }

  out.push(...chargeSection(lines), ...reviewSection(estimate, lines), ...pendingLine(estimate));

  const registry = estimate.registry;
  out.push(
    "",
    "---",
    `*${plural(registry.inPeriod, "invoice")} dated in ${estimate.periodLabel}; ` +
      `${registry.outOfPeriod} from another month; ${registry.undated} undated.*`,
    "",
    estimate.eligibilityNote, // already carries its own ⚠
  );
  return out.join("\n");
}
