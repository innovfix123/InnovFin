/**
 * Gateway Settlements MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (shared with the networked HTTPS route). Runs over stdio.
 * Launch: npx tsx src/mcp/gateway-settlements/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildGatewaySettlementsServer, GATEWAY_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildGatewaySettlementsServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`gateway-settlements MCP server ready (stdio) — tools: ${GATEWAY_TOOLS.join(", ")}`);
}
main().catch((e) => { console.error("gateway-settlements server failed:", e); process.exit(1); });
