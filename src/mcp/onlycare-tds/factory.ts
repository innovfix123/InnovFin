/**
 * buildOnlyCareServer — the single source of truth for the Only Care 194C toolset.
 * Both transports import this: the stdio entry (server.ts) and the networked HTTPS
 * route (src/app/mcp/onlycare-tds/route.ts). Registering tools in one place keeps the
 * local and remote surfaces byte-for-byte identical.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchOnlyCarePayouts } from "./payouts";
import { computeOnlyCareTds } from "./compute";
import { tracesUploadProvider, type TracesRecord } from "./pan-provider";
import { buildSec194CNonCompany } from "./workbook";
import { REPO_ROOT } from "./env";
import { round2 } from "./util";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");
const TRACES = z
  .array(z.object({ pan: z.string(), status: z.string().optional(), name: z.string().optional(), validity: z.string().optional() }))
  .optional();

/** Fresh, fully-wired Only Care TDS MCP server. Cheap to build — call once per stdio process or per HTTP request. */
export function buildOnlyCareServer(): McpServer {
  const server = new McpServer({ name: "onlycare-tds", version: "1.0.0" });

  server.registerTool("list_onlycare_payouts", {
    title: "List Only Care payouts",
    description: "Only Care creator payouts for a month (pre-TDS), read-only from the app DB. Input: period=YYYY-MM.",
    inputSchema: { period: PERIOD },
  }, async ({ period }) => {
    const rows = await fetchOnlyCarePayouts(period);
    const grossTotal = round2(rows.reduce((s, r) => s + r.grossAmount, 0));
    return { content: [{ type: "text", text: JSON.stringify({ source: "App-DB (Onlycare)", count: rows.length, grossTotal, rows }, null, 2) }] };
  });

  server.registerTool("onlycare_pan_status", {
    title: "Only Care PAN status",
    description: "Resolve PAN → {status, name, validity} via the TRACES-upload provider (PaySprint is a future drop-in). Pass pans[] and optional tracesRecords parsed from a TRACES bulk export.",
    inputSchema: { pans: z.array(z.string()), tracesRecords: TRACES },
  }, async ({ pans, tracesRecords }) => {
    const map = await tracesUploadProvider(tracesRecords as TracesRecord[] | undefined).verify(pans);
    return { content: [{ type: "text", text: JSON.stringify([...map.values()], null, 2) }] };
  });

  server.registerTool("compute_onlycare_tds", {
    title: "Compute Only Care 194C TDS",
    description: "Compute Only Care creator TDS (194C, code 1023) for a month via tds-core. Returns subtotal + per-payout rows + regression vs the filed anchor. writeWorkbook=true emits the Sec_194C_NonCompany xlsx on the server. Optional tracesRecords supply PAN operative/inoperative status.",
    inputSchema: { period: PERIOD, tracesRecords: TRACES, writeWorkbook: z.boolean().optional() },
  }, async ({ period, tracesRecords, writeWorkbook }) => {
    const result = await computeOnlyCareTds(period, tracesRecords as TracesRecord[] | undefined);
    let workbookPath: string | undefined;
    if (writeWorkbook) {
      const outDir = resolve(REPO_ROOT, "OnlyCare-TDS-mcp/out");
      mkdirSync(outDir, { recursive: true });
      workbookPath = resolve(outDir, `Sec_194C_NonCompany_${period}.xlsx`);
      writeFileSync(workbookPath, buildSec194CNonCompany(period, result.rows));
    }
    const { rows, ...rest } = result;
    return { content: [{ type: "text", text: JSON.stringify({ ...rest, workbookPath, rowCount: rows.length, rowsPreview: rows.slice(0, 5) }, null, 2) }] };
  });

  server.registerTool("onlycare_summary", {
    title: "Only Care 194C summary",
    description: "Section subtotal roll-up for Only Care 194C for a month (taxable, TDS, and the company-borne cost of inoperative PANs).",
    inputSchema: { period: PERIOD },
  }, async ({ period }) => {
    const r = await computeOnlyCareTds(period);
    const out = { period, section: "194C-non-company", ...r.subtotal, inoperativeCostINR: r.subtotal.companyLoss, regression: r.regression };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const ONLYCARE_TOOLS = ["list_onlycare_payouts", "onlycare_pan_status", "compute_onlycare_tds", "onlycare_summary"] as const;
