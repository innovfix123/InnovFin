/**
 * Hima TDS MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (to be shared with a networked HTTPS route later). Runs over stdio.
 * Launch: npx tsx src/mcp/hima-tds/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildHimaServer, HIMA_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildHimaServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`hima-tds MCP server ready (stdio) — tools: ${HIMA_TOOLS.join(", ")}`);
}
main().catch((e) => { console.error("hima-tds server failed:", e); process.exit(1); });
