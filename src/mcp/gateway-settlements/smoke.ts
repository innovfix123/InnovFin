/**
 * MCP smoke test — spawns the real Gateway Settlements server over stdio, lists tools, and calls a
 * couple through the MCP round-trip (proves the server layer, not just the logic). Uses app=Unman
 * (tiny volume) to stay fast. Run: npx tsx src/mcp/gateway-settlements/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const EXPECTED = ["list_settlements", "gateway_commission", "commission_summary", "reconcile_settlements"];

(async () => {
  const transport = new StdioClientTransport({
    command: resolve(REPO_ROOT, "node_modules/.bin/tsx"),
    args: [resolve(REPO_ROOT, "src/mcp/gateway-settlements/server.ts")],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("tools:", toolNames.join(", "));
  const allRegistered = EXPECTED.every((t) => toolNames.includes(t));

  const parseText = (res: unknown) => {
    const content = (res as { content?: unknown[] }).content;
    const text = Array.isArray(content) ? (content[0] as { text?: string })?.text ?? "" : "";
    return JSON.parse(text);
  };

  // (a) settlement-fee estimate (no invoice)
  const est = parseText(await client.callTool({ name: "gateway_commission", arguments: { period: "2026-05", app: "Unman" } }));
  const eLine = est.lines?.[0];
  console.log("gateway_commission(Unman) →", JSON.stringify({ basis: eLine?.taxableBasis, taxable194H: eLine?.taxable194H, tds194H: eLine?.tds194H, code: eLine?.code, majorHead: eLine?.majorHead }));

  // (b) invoice basis — supply an invoice figure → authoritative + reconciled against the settlement fee
  const inv = parseText(await client.callTool({ name: "gateway_commission", arguments: { period: "2026-05", app: "Unman", invoiceLines: [{ app: "Unman", gateway: "razorpay", taxable: 1000, invoiceRef: "SMOKE/1" }] } }));
  const iLine = inv.lines?.[0];
  console.log("gateway_commission(Unman, invoice ₹1000) →", JSON.stringify({ basis: iLine?.taxableBasis, tds194H: iLine?.tds194H, recon: iLine?.reconciliation?.driftPct }));

  // (c) carry-forward + deposit via commission_summary (reconcile:false → fast, invoice-only path)
  const sum = parseText(await client.callTool({ name: "commission_summary", arguments: { period: "2026-05", reconcile: false, invoiceLines: [{ app: "Only Care", gateway: "cashfree", taxable: 12695.67, invoiceRef: "CF/26-27/x" }], carryForward: [{ fromPeriod: "2026-04", shortfall: 6000, monthsLate: 2, ratePerMonth: 0.01 }] } }));
  console.log("commission_summary → 194H(invoice) ₹" + sum.summary?.tds194H, "| carry-forward interest ₹" + sum.carryForward?.totalInterest, "| totalToDeposit ₹" + sum.deposit?.totalToDeposit);

  await client.close();
  const ok = allRegistered
    && eLine?.taxableBasis === "settlement-derived" && eLine?.code === "1006" && eLine?.majorHead === "0020" && typeof eLine?.tds194H === "number"
    && iLine?.taxableBasis === "invoice" && iLine?.tds194H === 20 && iLine?.reconciliation != null
    && sum.carryForward?.totalInterest === 120;
  console.log(ok ? "\n✅ MCP round-trip OK — 4 tools; settlement estimate + invoice-basis (₹20) + carry-forward interest (₹120) all via the tools" : "\n❌ smoke failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("SMOKE FAILED:", e?.message ?? e); process.exit(2); });
