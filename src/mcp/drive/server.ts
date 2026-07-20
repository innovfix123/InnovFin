/**
 * Google Drive MCP server — stdio entry (local Claude Desktop / Claude Code via .mcp.json).
 * Tool definitions live in ./factory (shared with the networked HTTPS route). Runs over stdio.
 * Launch: npx tsx src/mcp/drive/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildDriveServer, DRIVE_TOOLS } from "./factory";

async function main(): Promise<void> {
  const server = buildDriveServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`drive MCP server ready (stdio) — tools: ${DRIVE_TOOLS.join(", ")}`);
}
main().catch((e) => {
  console.error("drive server failed:", e);
  process.exit(1);
});
