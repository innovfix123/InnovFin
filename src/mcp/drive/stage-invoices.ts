/**
 * Stage purchase-invoice documents out of the connected Drive folder for the invoice-intelligence
 * pipeline to ingest.
 *
 *   npx tsx --env-file=.env src/mcp/drive/stage-invoices.ts [--limit N] [--fy 2026-27] [--out DIR]
 *
 * Why staging rather than teaching Python to talk to Drive: the scope confinement, OAuth and retry
 * behaviour already live here and are tested. Duplicating them in a second language would be a second
 * thing to get wrong. This writes bytes plus a manifest; the Python side reads only that directory.
 *
 * What counts as a candidate: a PDF, image or Word file whose folder path contains "invoice",
 * "purchase" or "expense" — i.e. a document a human already filed under a vendor in the purchases
 * tree. Those are invoices by provenance, which is why the ingest runs them through the trusted-source
 * relevance gate instead of the mailbox's precision filter.
 *
 * Re-runnable: a file already staged (same Drive id and modifiedTime) is skipped, so an interrupted
 * run resumes instead of re-downloading gigabytes.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listChildren, downloadBytes, rootFolderId, type DriveFile } from "./drive-client";

const CANDIDATE = /^application\/pdf$|^image\/(jpeg|png|webp|gif)$|wordprocessingml\.document$/i;
const WANTED_PATH = /invoice|purchase|expense/i;

interface ManifestRow {
  driveId: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime?: string;
  drivePath: string;
  stagedFile: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const outDir = arg("--out") ?? "/var/www/innovfin/invoice-intelligence/build/drive-staging";
  const limit = Number(arg("--limit") ?? "0") || Infinity;
  const fyFilter = arg("--fy");
  mkdirSync(join(outDir, "files"), { recursive: true });

  const manifestPath = join(outDir, "manifest.json");
  const previous: ManifestRow[] = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")).files as ManifestRow[])
    : [];
  const already = new Map(previous.map((r) => [`${r.driveId}:${r.modifiedTime ?? ""}`, r]));

  const rows: ManifestRow[] = [];
  let scanned = 0;
  let skipped = 0;

  // Walk the tree ourselves so each file carries the folder path that decides whether it is a
  // purchase document — a flat search would lose exactly the context this depends on.
  async function walk(folderId: string, path: string): Promise<void> {
    if (rows.length >= limit) return;
    const { files, capped } = await listChildren(folderId);
    if (capped) console.error(`  ! ${path} is larger than one listing — some entries not staged`);
    for (const f of files) {
      if (rows.length >= limit) return;
      if (f.kind === "folder") {
        if (fyFilter && path === "" && f.name !== fyFilter) continue;
        await walk(f.id, `${path}/${f.name}`);
        continue;
      }
      scanned++;
      if (!CANDIDATE.test(f.mimeType) || !WANTED_PATH.test(path)) continue;

      const key = `${f.id}:${f.modifiedTime ?? ""}`;
      const seen = already.get(key);
      if (seen && existsSync(join(outDir, "files", seen.stagedFile))) {
        rows.push(seen);
        skipped++;
        continue;
      }
      const stagedFile = `${f.id}__${f.name.replace(/[^\w.\- ]+/g, "_")}`.slice(0, 180);
      try {
        writeFileSync(join(outDir, "files", stagedFile), await downloadBytes(f.id));
      } catch (e) {
        console.error(`  ! failed ${path}/${f.name}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      rows.push({
        driveId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        modifiedTime: f.modifiedTime,
        drivePath: `${path}/${f.name}`,
        stagedFile,
      });
      if (rows.length % 25 === 0) console.error(`  staged ${rows.length} (scanned ${scanned})`);
    }
  }

  console.error(`Staging into ${outDir}${fyFilter ? ` (FY ${fyFilter} only)` : ""}${limit !== Infinity ? `, limit ${limit}` : ""}`);
  await walk(rootFolderId(), "");
  writeFileSync(manifestPath, JSON.stringify({ generatedFrom: rootFolderId(), files: rows }, null, 2));
  console.error(`\nDONE: ${rows.length} documents staged (${skipped} reused), ${scanned} files scanned.`);
  console.error(`Manifest: ${manifestPath}`);
}

main().catch((e) => {
  console.error("stage-invoices failed:", e);
  process.exit(1);
});
