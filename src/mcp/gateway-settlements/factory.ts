/**
 * buildGatewaySettlementsServer — the single source of truth for the Gateway Settlements 194H toolset.
 *
 * The filed 194H is "as per invoice" (2% of each gateway's monthly commission invoice, GST-exclusive).
 * The gateway PG APIs expose only transaction-level settlement fees, so the tools take the invoice
 * figure (from GSTR-2B / the invoice, via invoiceLines) as AUTHORITATIVE and reconcile the live
 * settlement-fee figure against it. Also handles 194H carry-forward (prior-month shortfall + 201(1A)
 * interest). This is the 194H (commission/brokerage) source, separate from the 194C creator-payout MCPs.
 *
 * Both transports import this factory: the stdio entry (server.ts) and the networked HTTPS route.
 * Four tools: list_settlements, gateway_commission (the "commission/brokerage" call), commission_summary,
 * reconcile_settlements.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeCommission } from "./compute";
import { fetchReconcileLines } from "./settlements";
import { KNOWN_APPS } from "./gateways";
import { assertPeriod, monthLabel, round2 } from "./util";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");
const GATEWAY = z.enum(["cashfree", "razorpay", "phonepe"]);
const APP = z.string().describe(`app name, one of: ${KNOWN_APPS.join(", ")} (spacing/case-insensitive)`);
const ROW_CAP = 1000;

/** Invoice / manual line — authoritative fee figure (taxable) and/or reconcile net (netSettled). */
const MANUAL_LINE = z.object({
  app: z.string(),
  gateway: GATEWAY.optional(),
  taxable: z.number().optional(),          // 194H taxable (GST-EXCLUSIVE) from the invoice / report
  invoiceRef: z.string().optional(),       // e.g. "CF/26-27/35025"
  invoiceDate: z.string().optional(),
  gstOnCommission: z.number().optional(),
  grossVolume: z.number().optional(),
  netSettled: z.number().optional(),       // for reconcile
  settlements: z.array(z.object({ date: z.string(), net: z.number(), utr: z.string() })).optional(),
  note: z.string().optional(),
});

/** A prior-period 194H shortfall carried into this month's deposit (with 201(1A) interest). */
const CARRY_FORWARD = z.object({
  fromPeriod: PERIOD,
  section: z.literal("194H").optional(),
  shortfall: z.number(),
  depositedOn: z.string().optional(),      // YYYY-MM-DD
  monthsLate: z.number().optional(),       // explicit override (e.g. 2)
  ratePerMonth: z.number().optional(),     // default 0.01 (1%/mo, failure-to-deduct)
  note: z.string().optional(),
});

/** Fresh, fully-wired Gateway Settlements MCP server. Cheap to build — call once per stdio process or per HTTP request. */
export function buildGatewaySettlementsServer(): McpServer {
  const server = new McpServer({ name: "gateway-settlements", version: "1.1.0" });

  server.registerTool("list_settlements", {
    title: "List gateway settlements",
    description:
      "Raw settlement report per gateway/app for a month (read-only from the live gateway API). Input: period=YYYY-MM, optional app and/or gateway (cashfree|razorpay|phonepe). Returns one block per app×gateway line with its settlement batches — each {date, utr, gross, commission (fee), gst, net, status} — plus netSettled and count. Cashfree = settlement-date basis; per-batch net + utr are what land in the bank. PhonePe has NO API (manual only). Optional manualLines lets you supply PhonePe net rows {app, gateway:'phonepe', netSettled, settlements:[{date,net,utr}]}.",
    inputSchema: { period: PERIOD, app: APP.optional(), gateway: GATEWAY.optional(), includeRows: z.boolean().optional(), manualLines: z.array(MANUAL_LINE).optional() },
  }, async ({ period, app, gateway, includeRows, manualLines }) => {
    assertPeriod(period);
    const lines = await fetchReconcileLines(period, { app, gateway }, manualLines);
    const withRows = includeRows !== false;
    const out = {
      period, month: monthLabel(period),
      lines: lines.map((l) => ({
        app: l.app, gateway: l.gateway, configured: l.configured, basis: l.basis,
        count: l.count, netSettled: l.netSettled,
        settlements: withRows ? l.settlements.slice(0, ROW_CAP) : undefined,
        rowsReturned: withRows ? Math.min(ROW_CAP, l.settlements.length) : 0,
        source: l.source, note: l.note,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("gateway_commission", {
    title: "Gateway commission → 194H (commission / brokerage)",
    description:
      "The commission / brokerage call. Returns each gateway's 194H for a month. The FILED 194H is 'as per invoice' — 2% of the gateway's monthly commission INVOICE (GST-EXCLUSIVE; deposit code 1006, head 0020, from tds-core). The PG APIs don't expose that invoice, so pass it via invoiceLines [{app, gateway, taxable, invoiceRef, invoiceDate?, gstOnCommission?}] — taken from GSTR-2B (e.g. CF/26-27/…) or the invoice — and it's used as authoritative. The live settlement-fee figure is returned as settlementDerived and reconciled against the invoice (per-line drift). Input: period=YYYY-MM, optional app/gateway to slice. UPI is zero-MDR (nil fee is correct). Flags surface: no-invoice (estimate) lines, invoice↔settlement drift >5%, pending PhonePe (manual), zero/de-minimis fees, and any gateway PAN missing / equal to Innovfix's own PAN. Ask for 'commission' or 'brokerage' → this tool.",
    inputSchema: { period: PERIOD, app: APP.optional(), gateway: GATEWAY.optional(), invoiceLines: z.array(MANUAL_LINE).optional(), reconcile: z.boolean().optional() },
  }, async ({ period, app, gateway, invoiceLines, reconcile }) => {
    assertPeriod(period);
    const r = await computeCommission(period, { app, gateway }, { invoiceLines, reconcile });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("commission_summary", {
    title: "194H commission roll-up (all gateways) + deposit",
    description:
      "The 194H section roll-up across every gateway/app for a month: total taxable + TDS @ 2% (invoice-basis where invoiceLines are supplied, else an estimate from settlement fees), per-app breakdown, and per-line brief with invoice↔settlement reconciliation. Input: period=YYYY-MM; invoiceLines (authoritative invoice figures from GSTR-2B) and carryForward [{fromPeriod, shortfall, monthsLate|depositedOn, ratePerMonth?}] for prior-period 194H shortfalls. Returns a deposit block = current-month 194H + carried-forward shortfall + 201(1A) interest (tds-core). Pass reconcile:false for a fast invoice-only roll-up that skips the live gateway APIs. Includes the filed-anchor reconciliation reference (filed May-2026 194H = ₹26,865.70, invoice basis); regression.ok stays null until the invoice figures reconcile and Shoyab confirms. flagsSummary tallies every data-quality flag.",
    inputSchema: { period: PERIOD, invoiceLines: z.array(MANUAL_LINE).optional(), carryForward: z.array(CARRY_FORWARD).optional(), reconcile: z.boolean().optional() },
  }, async ({ period, invoiceLines, carryForward, reconcile }) => {
    assertPeriod(period);
    const r = await computeCommission(period, undefined, { invoiceLines, carryForward, reconcile });
    const brief = r.lines.map((l) => ({
      app: l.app, gateway: l.gateway, taxableBasis: l.taxableBasis,
      taxable194H: l.taxable194H, tds194H: l.tds194H,
      hasInvoice: l.invoice != null, hasSettlement: l.settlementDerived != null,
      reconDrift: l.reconciliation?.drift ?? null, flags: l.flags.length,
    }));
    const out = {
      period: r.period, month: monthLabel(period), section: r.section,
      basisNote: r.basisNote, deMinimisInr: r.deMinimisInr,
      summary: r.summary, byApp: r.byApp,
      carryForward: r.carryForward, deposit: r.deposit,
      filedReference: r.filedReference, regression: r.regression,
      lines: brief, flagsSummary: r.flagsSummary,
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("reconcile_settlements", {
    title: "Reconcile settlements vs bank",
    description:
      "Returns the SETTLEMENT side shaped to cross-check against the Innovfix Bank Data MCP. The gateway settles net (gross − fee) to our bank as one credit per batch, keyed by UTR. Input: period=YYYY-MM, optional app/gateway; optional manualLines for PhonePe (no API) net rows {app, gateway:'phonepe', netSettled, settlements:[{date,net,utr}]}. Per gateway line: netSettled total + count, and per-batch {date, net, utr}. MCPs can't call each other, so match at the Claude layer: take each {date, net, utr} and confirm it against the bank credits from the Bank MCP for that month.",
    inputSchema: { period: PERIOD, app: APP.optional(), gateway: GATEWAY.optional(), manualLines: z.array(MANUAL_LINE).optional() },
  }, async ({ period, app, gateway, manualLines }) => {
    assertPeriod(period);
    const lines = await fetchReconcileLines(period, { app, gateway }, manualLines);
    const out = {
      period, month: monthLabel(period),
      howToReconcile: "For each line, match every {date, net, utr} against the bank credits from the Innovfix Bank Data MCP for this month; the sum should equal netSettled. netSettled = gross − commission − GST.",
      lines: lines.map((l) => ({
        app: l.app, gateway: l.gateway, configured: l.configured, basis: l.basis,
        netSettled: l.netSettled, count: l.count,
        settlements: l.settlements.slice(0, ROW_CAP).map((s) => ({ date: s.date, net: s.net, utr: s.utr })),
        note: l.note,
      })),
      grandNetSettled: round2(lines.reduce((a, l) => a + (l.netSettled ?? 0), 0)),
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const GATEWAY_TOOLS = ["list_settlements", "gateway_commission", "commission_summary", "reconcile_settlements"] as const;
