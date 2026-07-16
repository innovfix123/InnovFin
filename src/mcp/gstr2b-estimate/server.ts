/**
 * Estimated GSTR-2B MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (shared with the networked HTTPS route). Needs the Python
 * invoice-intelligence MCP up on 127.0.0.1:8765 (pm2 invoice-intel-mcp) — the registry source.
 * Launch: npx tsx src/mcp/gstr2b-estimate/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildGstr2bEstimateServer, GSTR2B_ESTIMATE_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildGstr2bEstimateServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`gstr2b-estimate MCP server ready (stdio) — tools: ${GSTR2B_ESTIMATE_TOOLS.join(", ")}`);
}
main().catch((e) => { console.error("gstr2b-estimate server failed:", e); process.exit(1); });
