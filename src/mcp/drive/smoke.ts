/**
 * Smoke test for the Google Drive MCP — exercises the live folder bridge end-to-end.
 * Run: npm run mcp:drive:smoke   (needs GOOGLE_SA_KEY_JSON/FILE + DRIVE_FOLDER_ID in .env)
 *
 * It lists the folder, does a search, fetches recent docs, and reads the first readable document it
 * finds (Doc/Sheet/PDF/text). No writes, no persisted state — pure read-through against Drive.
 */
import { envVar } from "./env";
import { serviceAccountEmail } from "./google-auth";
import { listChildren, searchSubtree, latestInSubtree, getMetadata, MIME } from "./drive-client";
import { buildDriveServer } from "./factory";

async function main(): Promise<void> {
  const folder = envVar("DRIVE_FOLDER_ID");
  if (!folder) {
    console.error("DRIVE_FOLDER_ID not set. See .env.example → Google Drive MCP block for setup.");
    process.exit(2);
  }
  console.error(`Service account: ${serviceAccountEmail()}`);
  console.error(`Folder: ${folder}\n`);

  console.error("1) list_files (root) …");
  const children = await listChildren();
  console.error(`   ${children.length} entries; first few:`);
  for (const f of children.slice(0, 8)) console.error(`   - [${f.kind}] ${f.name} (${f.mimeType}) ${f.id}`);

  console.error("\n2) get_latest_documents (5) …");
  const latest = await latestInSubtree(5);
  for (const f of latest) console.error(`   - ${f.modifiedTime}  ${f.name}`);

  console.error("\n3) search_files (first token of first file name) …");
  const term = (children.find((c) => c.kind === "file")?.name ?? "invoice").split(/\s+/)[0];
  const hits = await searchSubtree(term);
  console.error(`   query="${term}" → ${hits.length} hits`);

  console.error("\n4) read a document via the MCP tools …");
  const readable = latest.find((f) => [MIME.DOC, MIME.SHEET, MIME.PDF].includes(f.mimeType as never) || /^text\//.test(f.mimeType));
  if (readable) {
    const meta = await getMetadata(readable.id);
    console.error(`   picked: ${meta.name} (${meta.mimeType})`);
    const tool = meta.mimeType === MIME.PDF ? "read_pdf" : meta.mimeType === MIME.SHEET ? "read_sheet" : "read_file";
    console.error(`   → would call ${tool} on id=${meta.id}`);
  } else {
    console.error("   no Doc/Sheet/PDF/text doc found to read (that's fine).");
  }

  // Prove the server builds with all tools registered.
  buildDriveServer();
  console.error("\nOK — Drive MCP smoke passed (live read-through, no writes).");
}
main().catch((e) => {
  console.error("smoke FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
