/**
 * TDS Working MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (shared with the networked HTTPS route). Runs over stdio.
 * Launch: npx tsx src/mcp/tds-working/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildTdsWorkingServer, TDS_WORKING_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildTdsWorkingServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`tds-working MCP server ready (stdio) — tools: ${TDS_WORKING_TOOLS.join(", ")}`);
}
main().catch((e) => { console.error("tds-working server failed:", e); process.exit(1); });
