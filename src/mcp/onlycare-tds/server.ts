/**
 * Only Care TDS MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (shared with the networked HTTPS route). Runs over stdio.
 * Launch: npx tsx src/mcp/onlycare-tds/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOnlyCareServer, ONLYCARE_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildOnlyCareServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`onlycare-tds MCP server ready (stdio) — tools: ${ONLYCARE_TOOLS.join(", ")}`);
}
main().catch((e) => { console.error("onlycare-tds server failed:", e); process.exit(1); });
