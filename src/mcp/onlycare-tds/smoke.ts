/**
 * MCP smoke test — spawns the real server over stdio, lists tools, and calls compute_onlycare_tds
 * for May 2026 through the MCP round-trip (proves the server layer, not just the logic).
 * Run: npx tsx src/mcp/onlycare-tds/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

(async () => {
  const transport = new StdioClientTransport({
    command: resolve(REPO_ROOT, "node_modules/.bin/tsx"),
    args: [resolve(REPO_ROOT, "src/mcp/onlycare-tds/server.ts")],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const res = await client.callTool({ name: "compute_onlycare_tds", arguments: { period: "2026-05" } });
  const text = Array.isArray(res.content) ? (res.content[0] as { text?: string })?.text ?? "" : "";
  const parsed = JSON.parse(text);
  console.log("compute_onlycare_tds → subtotal:", JSON.stringify(parsed.subtotal));
  console.log("regression:", JSON.stringify(parsed.regression));

  await client.close();
  console.log(parsed.regression?.ok ? "\n✅ MCP round-trip OK — anchor matched via the tool" : "\n❌ anchor drift via the tool");
  process.exit(parsed.regression?.ok ? 0 : 1);
})().catch((e) => { console.error("SMOKE FAILED:", e?.message ?? e); process.exit(2); });
