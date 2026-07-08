/**
 * buildHimaServer — the single source of truth for the Hima 194C toolset (5 tools).
 * hima_kyc_status wires the app-side KYC/verification signals into this SAME server (mirrors
 * onlycare_kyc_status): Perumal granted the `tdsapp_ro` login SELECT on kyc_verifications_v
 * (2026-07-06), which carries the PaySprint PAN check + bank penny-drop result per creator. Like
 * Only Care, this is reference / QA only — it NEVER feeds the 206AA rate (see kyc.ts).
 *
 * Both transports import this factory: the stdio entry (server.ts) and, later, a networked HTTPS
 * route — so the local and remote surfaces stay identical.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchHimaPayouts } from "./payouts";
import { fetchHimaPayoutCharges } from "./payout-charges";
import { fetchHimaKyc, summariseHimaKyc, type HimaKycRow } from "./kyc";
import { computeHimaTds } from "./compute";
import { tracesUploadProvider, type TracesRecord } from "./pan-provider";
import { buildSec194CNonCompany } from "./workbook";
import { REPO_ROOT } from "./env";
import { round2 } from "./util";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");
const TRACES = z
  .array(z.object({ pan: z.string(), status: z.string().optional(), name: z.string().optional(), validity: z.string().optional() }))
  .optional();

/** Fresh, fully-wired Hima TDS MCP server. Cheap to build — call once per stdio process or per HTTP request. */
export function buildHimaServer(): McpServer {
  const server = new McpServer({ name: "hima-tds", version: "1.0.0" });

  server.registerTool("list_hima_payouts", {
    title: "List Hima payouts",
    description: "Hima creator payouts for a month (pre-TDS), read-only from the app-DB view tds_creator_payouts_v (already paid-only, denormalized). Input: period=YYYY-MM. One row per payout, deduped on payout_id; each row carries transferId (Cashfree ref). cashfreeFee is NULL for May-2026 (reference-only column); netCredited is populated. Set withVerification=true to get a compact app-side verification EXCEPTION report instead of the raw rows: a verificationSummary (paid creators/payouts without a verified PAN or bank, shared-PAN counts — matches the compliance checks) plus unverifiedCreators (distinct creators paid without verification, largest gross first, capped). Reference/QA only — never affects TDS.",
    inputSchema: { period: PERIOD, withVerification: z.boolean().optional() },
  }, async ({ period, withVerification }) => {
    const rows = await fetchHimaPayouts(period);
    const grossTotal = round2(rows.reduce((s, r) => s + r.grossAmount, 0));
    if (!withVerification) {
      return { content: [{ type: "text", text: JSON.stringify({ source: "App-DB (Hima)", count: rows.length, grossTotal, rows }, null, 2) }] };
    }
    // Verification is CREATOR-level. At Hima's scale (~84k payouts/month) annotating every row would
    // be unusable to a caller and slow enough to time out the MCP round-trip, so return a COMPACT
    // exception report: the summary counts + the distinct creators paid WITHOUT a verified PAN/bank
    // (Perumal's check #1), largest gross first. Full per-creator detail is on hima_kyc_status.
    const creatorIds = [...new Set(rows.map((r) => r.creatorId))];
    const kyc = await fetchHimaKyc({ creatorIds });
    const byCreator = new Map<string, HimaKycRow>(kyc.map((k) => [k.creatorId, k]));
    const s = summariseHimaKyc(kyc);

    const agg = new Map<string, { payouts: number; gross: number }>();
    for (const r of rows) {
      const a = agg.get(r.creatorId) ?? { payouts: 0, gross: 0 };
      a.payouts += 1;
      a.gross += r.grossAmount;
      agg.set(r.creatorId, a);
    }

    const unverified = creatorIds
      .filter((id) => { const k = byCreator.get(id); return !k || !k.bankVerified || !k.panVerified; })
      .map((id) => {
        const k = byCreator.get(id);
        const a = agg.get(id)!;
        return {
          creatorId: id,
          pan: k?.pan ?? null,
          panStatus: k?.panStatus ?? null,
          panVerified: k ? k.panVerified : false,
          bankVerified: k ? k.bankVerified : false,
          panSharedByCreators: k?.panSharedByCreators ?? 0,
          payouts: a.payouts,
          gross: round2(a.gross),
          flags: k ? k.flags : ["No KYC/verification record on file"],
        };
      })
      .sort((x, y) => y.gross - x.gross);

    const creatorsWithNoKycRecord = creatorIds.filter((id) => !byCreator.has(id)).length;
    const verificationSummary = {
      creatorsPaid: creatorIds.length,
      creatorsWithNoKycRecord,
      // Headline exception counts — match Perumal's canonical checks = (no KYC record) + (KYC'd but unverified).
      creatorsPaidWithoutVerifiedPan: creatorsWithNoKycRecord + s.panUnverified,
      creatorsPaidWithoutVerifiedBank: creatorsWithNoKycRecord + s.bankUnverified,
      fullyVerified: s.fullyVerified,
      creatorsOnSharedPan: s.sharedPan,
      invalidAppPan: s.invalidPan,
      payoutsToUnverifiedBank: rows.filter((r) => { const k = byCreator.get(r.creatorId); return !k || !k.bankVerified; }).length,
      payoutsWithoutVerifiedPan: rows.filter((r) => { const k = byCreator.get(r.creatorId); return !k || !k.panVerified; }).length,
      payoutsOnSharedPan: rows.filter((r) => { const k = byCreator.get(r.creatorId); return k ? k.panSharedByCreators > 1 : false; }).length,
    };

    const CAP = 2000;
    const out = {
      source: "App-DB (Hima)",
      count: rows.length,
      grossTotal,
      verificationSummary,
      unverifiedCreators: {
        note: "Creators paid this month with no successful PAN or bank verification, largest gross first. Reference/QA only — does NOT affect TDS.",
        total: unverified.length,
        returned: Math.min(CAP, unverified.length),
        rows: unverified.slice(0, CAP),
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("hima_payout_charges", {
    title: "Hima payout charges (Cashfree fee → 194H)",
    description:
      "Monthly Cashfree PAYOUT-DISBURSAL charges for Hima, read-only from the app DB view (cf_service_charge). Returns Σ cashfree fee — the 194H commission BASE for disbursing payouts (SEPARATE from the payment-gateway MDR in the gateway-settlements MCP, and from the 194C on the payout amount) — plus the payout count and gross paid. Input: period=YYYY-MM. NOTE: cf_service_charge is populated ~Jul-2026 onward; feesPopulated=false (or a partial feePopulatedCount) means supply the month from the Cashfree payout invoice's \"Payouts Disbursed\" line (e.g. CF/26-27/35025 = ₹2,75,499.00 for May).",
    inputSchema: { period: PERIOD },
  }, async ({ period }) => {
    const charges = await fetchHimaPayoutCharges(period);
    return { content: [{ type: "text", text: JSON.stringify(charges, null, 2) }] };
  });

  server.registerTool("hima_kyc_status", {
    title: "Hima creator KYC / verification status",
    description: "App-side onboarding verification for Hima creators — reference/QA only, does NOT affect the TDS rate (206AA operative/inoperative status comes from TRACES, never the app DB). Look up by creatorIds[] and/or pans[]; returns per-creator {pan, panStatus, panVerified, panChecks, bankVerified, bankChecks, bankFailures, lastBankFailureReason, panSharedByCreators, fullyVerified, flags} plus a summary. Surfaces creators paid without a verified bank / verified PAN and PANs shared across creators. Source: kyc_verifications_v (PaySprint PAN check + bank penny-drop). NOTE: pan_verification is only logged on success, so 'not verified' means no successful PAN check on record; panStatus (VALID/INVALID/null) is the app KYC flag, NOT the 206AA status.",
    inputSchema: { creatorIds: z.array(z.string()).optional(), pans: z.array(z.string()).optional() },
  }, async ({ creatorIds, pans }) => {
    if (!creatorIds?.length && !pans?.length) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Provide at least one of creatorIds[] or pans[]." }) }] };
    }
    const rows = await fetchHimaKyc({ creatorIds, pans });
    const found = new Set(rows.map((r) => r.creatorId));
    const notFoundCreatorIds = (creatorIds ?? []).filter((id) => !found.has(String(id)));
    return { content: [{ type: "text", text: JSON.stringify({ source: "App-DB (Hima)", summary: summariseHimaKyc(rows), notFoundCreatorIds, rows }, null, 2) }] };
  });

  server.registerTool("hima_pan_status", {
    title: "Hima PAN status",
    description: "Resolve PAN → {status, name, validity} via the TRACES-upload provider (PaySprint is a future drop-in). Pass pans[] and optional tracesRecords parsed from a TRACES bulk export. NOTE: the app-DB `pan_status` column (VALID/INVALID/NULL, mostly NULL) is the app KYC flag, NOT the 206AA operative/inoperative status — this tool never reads it.",
    inputSchema: { pans: z.array(z.string()), tracesRecords: TRACES },
  }, async ({ pans, tracesRecords }) => {
    const map = await tracesUploadProvider(tracesRecords as TracesRecord[] | undefined).verify(pans);
    return { content: [{ type: "text", text: JSON.stringify([...map.values()], null, 2) }] };
  });

  server.registerTool("compute_hima_tds", {
    title: "Compute Hima 194C TDS",
    description: "Compute Hima creator TDS (194C, code 1023) for a month via tds-core. Returns subtotal + per-payout rows + a regression block. The filed rupee anchor is NOT locked yet (see filedReference — ~₹93k gross gap + 206AA method to reconcile). writeWorkbook=true emits the Sec_194C_NonCompany xlsx on the server. Optional tracesRecords supply PAN operative/inoperative status.",
    inputSchema: { period: PERIOD, tracesRecords: TRACES, writeWorkbook: z.boolean().optional() },
  }, async ({ period, tracesRecords, writeWorkbook }) => {
    const result = await computeHimaTds(period, tracesRecords as TracesRecord[] | undefined);
    let workbookPath: string | undefined;
    if (writeWorkbook) {
      const outDir = resolve(REPO_ROOT, "Hima-TDS-mcp/out");
      mkdirSync(outDir, { recursive: true });
      workbookPath = resolve(outDir, `Sec_194C_NonCompany_${period}.xlsx`);
      writeFileSync(workbookPath, buildSec194CNonCompany(period, result.rows));
    }
    const { rows, ...rest } = result;
    return { content: [{ type: "text", text: JSON.stringify({ ...rest, workbookPath, rowCount: rows.length, rowsPreview: rows.slice(0, 5) }, null, 2) }] };
  });

  server.registerTool("hima_summary", {
    title: "Hima 194C summary",
    description: "Section subtotal roll-up for Hima 194C for a month (taxable, TDS deposited, gross×1% reference, and the company-borne cost of inoperative/no-PAN rows). Includes the filed-anchor reconciliation reference.",
    inputSchema: { period: PERIOD },
  }, async ({ period }) => {
    const r = await computeHimaTds(period);
    const out = { period, section: "194C-non-company", ...r.subtotal, inoperativeCostINR: r.subtotal.companyLoss, regression: r.regression, filedReference: r.filedReference };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const HIMA_TOOLS = ["list_hima_payouts", "hima_kyc_status", "hima_pan_status", "compute_hima_tds", "hima_summary"] as const;
