/**
 * MCP smoke test — spawns the real Hima server over stdio, lists tools, and calls compute_hima_tds
 * for May 2026 through the MCP round-trip (proves the server layer, not just the logic).
 * Run: npx tsx src/mcp/hima-tds/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

(async () => {
  const transport = new StdioClientTransport({
    command: resolve(REPO_ROOT, "node_modules/.bin/tsx"),
    args: [resolve(REPO_ROOT, "src/mcp/hima-tds/server.ts")],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("tools:", toolNames.join(", "));
  const hasKyc = toolNames.includes("hima_kyc_status");

  const res = await client.callTool({ name: "compute_hima_tds", arguments: { period: "2026-05" } });
  const text = Array.isArray(res.content) ? (res.content[0] as { text?: string })?.text ?? "" : "";
  const parsed = JSON.parse(text);
  console.log("compute_hima_tds → subtotal:", JSON.stringify(parsed.subtotal));
  console.log("regression:", JSON.stringify(parsed.regression));

  await client.close();
  const structuralOk = parsed.subtotal?.payouts === 84109 && parsed.subtotal?.creators === 9958;
  const ok = structuralOk && hasKyc;
  if (!hasKyc) console.log("❌ hima_kyc_status not registered");
  console.log(ok ? "\n✅ MCP round-trip OK — 5 tools registered + May structural anchor matched via the tool" : "\n❌ smoke failed (structural or tool-registration)");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("SMOKE FAILED:", e?.message ?? e); process.exit(2); });
