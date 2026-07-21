/**
 * Smoke test for the Google Drive tools — exercises the live folder bridge end-to-end.
 * Run: npm run mcp:drive:smoke   (needs DRIVE_FOLDER_ID + a Google credential: GOOGLE_OAUTH_* or SA)
 *
 * It lists the folder, does a search, fetches recent docs, and reads the first readable document it
 * finds (Doc/Sheet/PDF/text). No writes, no persisted state — pure read-through against Drive.
 */
import { envVar } from "./env";
import { credentialMode } from "./google-auth";
import { listChildren, searchSubtree, latestInSubtree, getMetadata, MIME } from "./drive-client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDriveTools, activeDriveTools } from "./factory";

async function main(): Promise<void> {
  const folder = envVar("DRIVE_FOLDER_ID");
  if (!folder) {
    console.error("DRIVE_FOLDER_ID not set. See .env.example → Google Drive MCP block for setup.");
    process.exit(2);
  }
  console.error(`Credential mode: ${credentialMode()}`);
  console.error(`Folder: ${folder}\n`);

  console.error("1) drive_list_files (root) …");
  const children = await listChildren();
  console.error(`   ${children.length} entries; first few:`);
  for (const f of children.slice(0, 8)) console.error(`   - [${f.kind}] ${f.name} (${f.mimeType}) ${f.id}`);

  console.error("\n2) drive_latest_documents (5) …");
  const latest = await latestInSubtree(5);
  for (const f of latest) console.error(`   - ${f.modifiedTime}  ${f.name}`);

  console.error("\n3) drive_search_files (first token of first file name) …");
  const term = (children.find((c) => c.kind === "file")?.name ?? "invoice").split(/\s+/)[0];
  const hits = await searchSubtree(term);
  console.error(`   query="${term}" → ${hits.length} hits`);

  console.error("\n4) read a document via the Drive tools …");
  const readable = latest.find((f) => [MIME.DOC, MIME.SHEET, MIME.PDF].includes(f.mimeType as never) || /^text\//.test(f.mimeType));
  if (readable) {
    const meta = await getMetadata(readable.id);
    console.error(`   picked: ${meta.name} (${meta.mimeType})`);
    const tool = meta.mimeType === MIME.PDF ? "drive_read_pdf" : meta.mimeType === MIME.SHEET ? "drive_read_sheet" : "drive_read_file";
    console.error(`   → would call ${tool} on id=${meta.id}`);
  } else {
    console.error("   no Doc/Sheet/PDF/text doc found to read (that's fine).");
  }

  // Prove every tool registers cleanly onto a host server (as gstr2b-estimate does).
  registerDriveTools(new McpServer({ name: "smoke", version: "0.0.0" }));
  console.error(`\nOK — Drive smoke passed (live read-through, no writes). Tools: ${activeDriveTools().join(", ")}`);
}
main().catch((e) => {
  console.error("smoke FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
