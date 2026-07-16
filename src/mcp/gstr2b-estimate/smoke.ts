/**
 * Smoke check against the LIVE registry (needs the Python invoice MCP up — pm2 invoice-intel-mcp
 * on 127.0.0.1:8765). Builds the estimate for a period straight through source → compute and
 * prints it, so the localhost hop, the canonical-field mapping and the bucketing are all exercised.
 *
 * Run: npm run mcp:gstr2b:smoke [-- <period> [<received_to>]]   (default period 2026-07)
 */
import { buildEstimate } from "./compute";
import { fetchAcceptedInvoices, fetchNeedsReviewPending } from "./source";

async function main(): Promise<void> {
  const period = process.argv[2] ?? "2026-07";
  const receivedTo = process.argv[3] ?? null;
  const [invoices, needsReviewPending] = await Promise.all([
    fetchAcceptedInvoices(receivedTo),
    fetchNeedsReviewPending(period, receivedTo),
  ]);
  const { estimate } = buildEstimate(invoices, { period, receivedTo, needsReviewPending });
  console.log(JSON.stringify(estimate, null, 2));
  console.error(
    `\nsmoke ok — period ${period}${receivedTo ? ` as of ${receivedTo}` : ""}: ` +
    `${estimate.estimate.invoices} included (ITC ₹${estimate.estimate.itcTotal}), ` +
    `${estimate.underReview.invoices} under review, ${estimate.registry.outOfPeriod} other-month`,
  );
}
main().catch((e) => { console.error("gstr2b-estimate smoke failed:", e); process.exit(1); });
