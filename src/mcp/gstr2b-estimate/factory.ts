/**
 * buildGstr2bEstimateServer — the Estimated GSTR-2B / ITC MCP: what input-tax credit Innovfix
 * should EXPECT for a period, from vendor invoices already in hand (the invoice-intelligence
 * registry) — days before GSTN publishes the real GSTR-2B on the 14th. Three tools:
 *
 *   itc_estimate  — the month's expected ITC, aggregated by vendor GSTIN × tax head, with the
 *                   eligibility review bucket kept separate (point-in-time via received_to)
 *   itc_invoices  — the per-invoice lines behind the estimate (included / review / all)
 *   itc_reconcile — the estimate held against the ACTUAL portal 2B workbook once it exists
 *                   (reuses src/lib/gstr2b.ts parse + src/gst-core/reconcile.ts matcher)
 *
 * Both transports import this factory: the stdio entry (server.ts) and the networked HTTPS route.
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bufferToSheets } from "@/lib/workbook";
import { parseGstr2b } from "@/lib/gstr2b";
import { buildEstimate, reconcileVsActual, ELIGIBILITY_NOTE, ESTIMATE_BASIS } from "./compute";
import { renderEstimateReport } from "./report";
import { fetchAcceptedInvoices, fetchNeedsReviewPending } from "./source";
import { assertIsoDate, assertPeriod } from "./util";
import { REPO_ROOT } from "./env";
import { registerDriveTools, activeDriveTools } from "@/mcp/drive/factory";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");
const RECEIVED_TO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "received_to must be YYYY-MM-DD")
  .describe("point-in-time cut-off: count only invoices whose MAIL ARRIVED on or before this date (inclusive) — e.g. 'estimate as of the 3rd'");
const BUCKET = z.enum(["included", "review", "all"])
  .describe("included = clean lines counted in the headline; review = flagged lines excluded pending review; all (default) = both");

/** The GSTR-2B drop folder — the only place itc_reconcile will read a workbook path from. */
export const DROP_DIR = resolve(REPO_ROOT, "GSTR-2B-est-mcp");

/** Resolve exactly one of file/file_base64 into the portal workbook bytes. */
export function readWorkbook(file?: string, fileBase64?: string): Buffer {
  if ((file ? 1 : 0) + (fileBase64 ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of `file` (path under GSTR-2B-est-mcp/) or `file_base64` (the workbook itself).");
  }
  if (fileBase64) return Buffer.from(fileBase64, "base64");
  const p = resolve(REPO_ROOT, file as string);
  if (p === DROP_DIR || !p.startsWith(DROP_DIR + sep)) {
    throw new Error(`file must be a workbook under GSTR-2B-est-mcp/ (the 2B drop folder) — got "${file}"`);
  }
  return readFileSync(p);
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

/** Fresh, fully-wired Estimated GSTR-2B MCP server. Cheap to build — one per stdio process or HTTP request. */
export function buildGstr2bEstimateServer(): McpServer {
  const server = new McpServer({ name: "gstr2b-estimate", version: "1.0.0" });

  server.registerTool("itc_estimate", {
    title: "Estimated GSTR-2B — expected ITC for a month",
    description:
      "The ESTIMATED GSTR-2B: expected input-tax credit for a month, computed from vendor invoices in hand " +
      "(accepted rows of the invoice-intelligence registry) — NOT the filed GSTR-2B (GSTN publishes that on the " +
      "14th; the estimate exists precisely so finance has a number before then). Aggregates input GST by vendor " +
      "GSTIN and tax head (IGST/CGST/SGST/cess). Headline = invoices that pass the first-draft eligibility layer; " +
      "everything flagged — Section 17(5) blocked-credit suspects, reverse-charge suspects, missing/invalid/own " +
      "GSTIN, missing tax breakup, no invoice date (⚠ rules pending Shoyab) — sits in a separate review bucket " +
      "with reasons, never auto-included. Optional received_to=YYYY-MM-DD gives the point-in-time view finance " +
      "pulls early in the month: 'expected ITC for June as of 3 July' → period=2026-06, received_to=2026-07-03. " +
      "Ask for 'estimated 2B', 'expected ITC', 'ITC estimate as of the Nth' → this tool.\n\n" +
      "PRESENTING THE RESULT: the `report` field is the finished markdown breakdown — ITC by tax head, " +
      "supplier-wise, charge-wise, the review bucket with exclusion reasons, and the pending queue. SHOW IT TO " +
      "THE USER AS-IS (verbatim, tables intact). Do not re-format it, re-order it, summarise it into prose, or " +
      "rebuild your own tables from the JSON fields — those fields are there to compute on when asked a follow-up " +
      "question, not to re-render the report from. Foreign-currency amounts in `report` already carry their ISO " +
      "code (USD 240, never ₹240); never restate a non-INR figure with a rupee sign.",
    inputSchema: { period: PERIOD, received_to: RECEIVED_TO.optional() },
  }, async ({ period, received_to }) => {
    assertPeriod(period);
    if (received_to) assertIsoDate(received_to);
    const [invoices, needsReviewPending] = await Promise.all([
      fetchAcceptedInvoices(received_to),
      fetchNeedsReviewPending(period, received_to),
    ]);
    const { estimate, lines } = buildEstimate(invoices, { period, receivedTo: received_to ?? null, needsReviewPending });
    // `report` is the deliverable; the rest of the payload is the same data to compute on.
    return json({ report: renderEstimateReport(estimate, lines), ...estimate });
  });

  server.registerTool("itc_invoices", {
    title: "Estimated GSTR-2B — the per-invoice lines",
    description:
      "The per-invoice detail behind itc_estimate for a period: every accepted registry invoice dated in the " +
      "month (plus undated ones, which route to review), each with its GST breakup (IGST/CGST/SGST/cess), the " +
      "bucket it landed in and every eligibility flag with its reason. bucket=included|review|all (default all). " +
      "Each line also carries `lineItems` — the per-service charge rows parsed from the invoice itself " +
      "(description, HSN/SAC, GST%, quantity, amount transacted vs the taxable charge), with per-category " +
      "subtotals and a check that they sum back to the taxable value: this is WHERE an invoice's taxable (and " +
      "thus its CGST/SGST/IGST) comes from. It is null when the vendor's invoice layout isn't parsed yet " +
      "(Cashfree today); the raw text still lives in the registry via the invoices MCP get_invoice. " +
      "Use this to work the review queue ('why is this invoice not counted?'), to eyeball a vendor's lines, or " +
      "to export the estimate register. Point-in-time via received_to, same as itc_estimate. Output is an " +
      "ESTIMATE register, not the filed 2B.",
    inputSchema: { period: PERIOD, received_to: RECEIVED_TO.optional(), bucket: BUCKET.optional() },
  }, async ({ period, received_to, bucket }) => {
    assertPeriod(period);
    if (received_to) assertIsoDate(received_to);
    const invoices = await fetchAcceptedInvoices(received_to);
    const { lines } = buildEstimate(invoices, { period, receivedTo: received_to ?? null });
    const want = bucket ?? "all";
    const filtered = want === "all" ? lines : lines.filter((l) => (want === "included") === l.included);
    return json({
      basis: ESTIMATE_BASIS,
      eligibilityNote: ELIGIBILITY_NOTE,
      period,
      receivedTo: received_to ?? null,
      bucket: want,
      count: filtered.length,
      lines: filtered,
    });
  });

  server.registerTool("itc_reconcile", {
    title: "Estimate vs ACTUAL GSTR-2B reconciliation",
    description:
      "Once the real GSTR-2B exists (the 14th): parse the GST-portal GSTR-2B Excel workbook and hold the " +
      "invoices-in-hand estimate against it. Pass the workbook as `file` (a path under GSTR-2B-est-mcp/, the 2B " +
      "drop folder on the server) or `file_base64` (the .xlsx itself). Returns (1) the headline diff — clean " +
      "estimate vs the portal's ITC-Available 4(A)(5) row per head, with estimateWithReview as the upper bound; " +
      "(2) the invoice-level match by GSTIN+invoice number via the tested books↔2B reconciler: matched (with any " +
      "tax differences), inBooksNotIn2b (supplier hasn't filed → ITC at risk, chase), in2bNotInBooks (invoice " +
      "never captured in the registry → book it); (3) what couldn't join the match and the portal's " +
      "reversed/ineligible rows; and (4) `coverage` — WHAT SHARE OF OUR REAL ITC THE ESTIMATE IS SEEING, " +
      "and the ranked worklist to close it: coveragePct, every portal supplier ranked by ITC with share/" +
      "cumulative share and captured|partial|missing status, the exact missing invoice numbers + dates to go " +
      "and collect from each, and `scenarios` — a what-if walk (\"+ GOOGLE INDIA → 86.55%\", \"+ META → 96.09%\") " +
      "showing the coverage you reach by capturing each next-largest supplier. Use coverage to answer 'why is " +
      "the estimate so far off', 'who do we chase', 'what would we cover if vendor X emailed invoices@', 'which " +
      "suppliers are we missing'. Ask 'reconcile the 2B', 'estimate vs actual', 'did our ITC land' → this tool.",
    inputSchema: {
      period: PERIOD,
      file: z.string().describe("path to the portal GSTR-2B .xlsx under GSTR-2B-est-mcp/ (e.g. GSTR-2B-est-mcp/2b/GSTR2B_29AAICI1603A1Z3_062026.xlsx)").optional(),
      file_base64: z.string().describe("the portal GSTR-2B .xlsx itself, base64-encoded — alternative to file").optional(),
      received_to: RECEIVED_TO.optional(),
    },
  }, async ({ period, file, file_base64, received_to }) => {
    assertPeriod(period);
    if (received_to) assertIsoDate(received_to);
    const twoB = parseGstr2b(bufferToSheets(readWorkbook(file, file_base64)));
    const invoices = await fetchAcceptedInvoices(received_to);
    const { lines } = buildEstimate(invoices, { period, receivedTo: received_to ?? null });
    return json(reconcileVsActual(lines, twoB, { period, receivedTo: received_to ?? null }));
  });

  // Google Drive tools (drive_*) are MOUNTED here rather than run as their own endpoint: the ITC
  // numbers and the source documents they came from belong on one connection. Read tools always;
  // write tools only when DRIVE_MCP_WRITE is on. See src/mcp/drive/factory.ts.
  registerDriveTools(server);

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const ITC_TOOLS = ["itc_estimate", "itc_invoices", "itc_reconcile"] as const;
/** Everything this server exposes right now, ITC + the mounted Drive tools (write-flag aware). */
export function gstr2bEstimateTools(): string[] {
  return [...ITC_TOOLS, ...activeDriveTools()];
}
/** Back-compat: the ITC tool names. Prefer gstr2bEstimateTools() for the full, live list. */
export const GSTR2B_ESTIMATE_TOOLS = ITC_TOOLS;
