/**
 * registerDriveTools — the single source of truth for the Google Drive toolset.
 *
 * These tools are a LIVE BRIDGE to one shared Google Drive folder (DRIVE_FOLDER_ID). Google Drive is
 * the Single Source of Truth: every tool reads live from Drive on each call, so a new upload, an edit,
 * a rename, a move, or a delete is reflected immediately with no synchronization step. Nothing is
 * persisted and no file bytes are stored — only a 60s in-memory cache of the folder-tree's folder IDs
 * (pure metadata) to keep search cheap. File CONTENT is always fetched fresh from Drive.
 *
 * There is deliberately NO standalone /mcp/drive endpoint: these tools are MOUNTED INTO the
 * gstr2b-estimate MCP (src/mcp/gstr2b-estimate/factory.ts) so finance has one connection that can both
 * compute ITC and read the source documents. Tool names are prefixed `drive_` so they never collide
 * with the host server's own tools and are unambiguous to the model.
 *
 * Six read tools (always) + six write tools (only when DRIVE_MCP_WRITE is enabled).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as XLSX from "xlsx";
import {
  listChildren,
  searchSubtree,
  latestInSubtree,
  getMetadata,
  downloadBytes,
  exportFile,
  rootFolderId,
  createFolder,
  uploadTextFile,
  updateFileContent,
  renameFile,
  moveFile,
  trashFile,
  readViaGoogleConversion,
  MIME,
  type DriveFile,
} from "./drive-client";
import { writeEnabled } from "./env";

/** Cap on how much extracted text any read_* tool returns, to keep responses sane. */
const TEXT_CAP = 200_000;

/**
 * Types we cannot parse but Google can convert to a Doc: photos and scans (OCR runs during the copy)
 * and Word files. Together these are ~17% of the connected folder — receipts, signed agreements — and
 * without conversion every one of them is unanswerable.
 */
const CONVERTIBLE = /^image\/|wordprocessingml\.document$|^application\/msword$|^(application|text)\/rtf$/i;

/**
 * Uploads that really are text. Anchored on purpose: the old test was /^text\/|json|xml|csv/i, and
 * every Office mime type contains "openxmlformats" — so .docx and .xlsx matched it and came back as
 * a ZIP decoded as UTF-8 (screenfuls of "PK...word/_rels"), looking like a successful read.
 */
const TEXTUAL = /^text\/|^application\/(json|xml|csv|x-ndjson)$|\+json$|\+xml$/i;

const jsonText = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

/** Trim a metadata row to the fields agents actually use. */
function brief(f: DriveFile) {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    mimeType: f.mimeType,
    size: f.size,
    modifiedTime: f.modifiedTime,
    modifiedBy: f.modifiedBy,
    owner: f.owner,
    webViewLink: f.webViewLink,
    ...(f.isShortcut ? { isShortcut: true, shortcutTarget: f.shortcutTarget } : {}),
  };
}

function capText(s: string): { text: string; truncated: boolean } {
  if (s.length <= TEXT_CAP) return { text: s, truncated: false };
  return { text: s.slice(0, TEXT_CAP), truncated: true };
}

/** Lazily load pdf-parse's inner module (index.js runs debug code under a bundler — avoid it). */
async function extractPdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const mod = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as {
    default: (b: Buffer) => Promise<{ text: string; numpages: number }>;
  };
  const pdfParse = mod.default ?? (mod as unknown as (b: Buffer) => Promise<{ text: string; numpages: number }>);
  const d = await pdfParse(buf);
  return { text: d.text ?? "", pages: d.numpages ?? 0 };
}

/**
 * A PDF with no text layer is a scan. Hand it to Google's OCR rather than answering "OCR needed" —
 * scanned invoices and receipts are exactly the documents people ask about.
 */
async function ocrPdfFallback(meta: DriveFile, pages: number | undefined) {
  if (!writeEnabled()) {
    return jsonText({
      file: brief(meta),
      pages,
      error: "ocr_unavailable",
      content: "",
      note: "No embedded text — this is a scanned PDF. OCR needs a temporary Google-Doc conversion, which requires DRIVE_MCP_WRITE on the server. Open the webViewLink instead.",
      webViewLink: meta.webViewLink,
    });
  }
  try {
    const raw = await readViaGoogleConversion(meta.id);
    if (!raw.trim()) {
      return jsonText({ file: brief(meta), pages, extractedAs: "google-ocr", content: "", note: "Scanned PDF, and OCR found no legible text.", webViewLink: meta.webViewLink });
    }
    const { text, truncated } = capText(raw);
    return jsonText({ file: brief(meta), pages, extractedAs: "google-ocr", truncated, content: text, note: "No embedded text layer — this text came from OCR of a scan, so verify figures against the image before relying on them." });
  } catch (e) {
    return jsonText({
      file: brief(meta),
      pages,
      error: "ocr_failed",
      content: "",
      note: `Scanned PDF and OCR failed: ${e instanceof Error ? e.message : String(e)}`,
      webViewLink: meta.webViewLink,
    });
  }
}

/**
 * Mount every Drive tool onto an existing MCP server (the gstr2b-estimate one). Returns the same
 * server for chaining. Write tools are registered only when DRIVE_MCP_WRITE is enabled.
 */
export function registerDriveTools(server: McpServer): McpServer {
  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_list_files",
    {
      title: "List files & folders in the Drive folder",
      description:
        "List the files and folders inside the connected Google Drive folder (the Single Source of Truth). Reads LIVE from Drive — new uploads, renames, moves and deletes are reflected instantly. Input: optional folderId to drill into a subfolder (must be inside the connected folder tree; omit for the root). Returns each entry with id, name, kind (file|folder), mimeType, size, modifiedTime, modifiedBy, owner and webViewLink. Folders are listed first. Trashed items are excluded.",
      inputSchema: { folderId: z.string().optional().describe("subfolder id to list; omit for the connected root folder") },
    },
    async ({ folderId }) => {
      const files = await listChildren(folderId);
      return jsonText({
        folderId: folderId?.trim() || rootFolderId(),
        count: files.length,
        files: files.map(brief),
      });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_search_files",
    {
      title: "Search files by name or content",
      description:
        "Search the connected Google Drive folder (and all its subfolders) by file name AND full-text content. Reads live from Drive. Input: query (a word or phrase, e.g. 'Cashfree invoice May' or a vendor/GSTIN). Results are ordered filename-matches first, then newest-first, so the best candidates lead. `capped: true` means there were more matches than the cap — narrow the query instead of treating the list as complete. Returns id, name, mimeType, size, modifiedTime, owner and webViewLink; use drive_read_file / drive_read_sheet / drive_read_pdf on an id to get the actual content. Full-text matching is Google's own Drive index (covers document bodies for supported types).",
      inputSchema: { query: z.string().min(1).describe("name or content to search for within the folder") },
    },
    async ({ query }) => {
      const { files, capped, partialSubtree } = await searchSubtree(query);
      const notes = [
        capped && `More than ${files.length} files match — this is the capped, newest-first list with filename matches first. Narrow the query rather than assuming this is every match.`,
        partialSubtree && "The folder tree is larger than this search can sweep, so some subfolders were not searched. Browse with drive_list_files if you expect a file that isn't here.",
      ].filter(Boolean);
      return jsonText({
        query,
        count: files.length,
        capped,
        ...(partialSubtree ? { partialSubtree } : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
        files: files.map(brief),
      });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_latest_documents",
    {
      title: "Get the most recently changed documents",
      description:
        "Return the most recently added or edited documents in the connected Drive folder tree, newest first — the fastest way to see 'what did Finance just upload/change'. Reads live from Drive. Input: optional limit (default 15, max 100). Folders are excluded; only documents. Returns id, name, mimeType, size, modifiedTime, modifiedBy, owner and webViewLink.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("how many recent documents (default 15)") },
    },
    async ({ limit }) => {
      const files = await latestInSubtree(limit ?? 15);
      return jsonText({ count: files.length, files: files.map(brief) });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_read_file",
    {
      title: "Read a file's content as text",
      description:
        "Read the content of a single file (by id) as text, fetched live from Drive. Google Docs → plain text; Google Sheets → CSV (use drive_read_sheet for multi-tab structure); Google Slides → text; plain-text/CSV/JSON uploads → their text; PDFs → text extraction, falling back to OCR for scans (or use drive_read_pdf). IMAGES (photo/scan of a receipt, invoice, cheque) and WORD files (.docx/.doc/.rtf) ARE readable here — Google converts and OCRs them, and the result comes back with extractedAs='google-ocr'; treat OCR'd figures as needing a sanity check. Spreadsheets are the one thing to send elsewhere: use drive_read_sheet. Google-native docs over 10 MB can't be exported by the API (Google limit); the tool then returns the webViewLink instead. Input: fileId (from drive_list_files/drive_search_files).",
      inputSchema: { fileId: z.string().min(1).describe("the file id to read") },
    },
    async ({ fileId }) => {
      const meta = await getMetadata(fileId);
      const nativeExport: Record<string, string> = {
        [MIME.DOC]: "text/plain",
        [MIME.SHEET]: "text/csv",
        [MIME.SLIDES]: "text/plain",
      };
      // Google-native document → export.
      if (nativeExport[meta.mimeType]) {
        try {
          const buf = await exportFile(fileId, nativeExport[meta.mimeType]);
          const { text, truncated } = capText(buf.toString("utf8"));
          return jsonText({ file: brief(meta), extractedAs: nativeExport[meta.mimeType], truncated, content: text });
        } catch (e) {
          if (e instanceof Error && e.message === "EXPORT_TOO_LARGE") {
            return jsonText({ file: brief(meta), error: "too_large_to_export", note: "This Google document exceeds the 10 MB API export limit. Open it directly.", webViewLink: meta.webViewLink });
          }
          throw e;
        }
      }
      // PDF → extract text.
      if (meta.mimeType === MIME.PDF) {
        const buf = await downloadBytes(fileId);
        let pages: number | undefined;
        try {
          const out = await extractPdfText(buf);
          pages = out.pages;
          if (out.text.trim()) {
            const { text: t, truncated } = capText(out.text);
            return jsonText({ file: brief(meta), extractedAs: "pdf-text", pages, truncated, content: t });
          }
        } catch {
          /* fall through to OCR — a scan often fails to parse rather than parsing to empty */
        }
        return ocrPdfFallback(meta, pages);
      }
      // Photos/scans and Word files: Google can read these even though we can't parse them. Let it —
      // otherwise a receipt photo or a signed .docx is simply unanswerable. Checked BEFORE the
      // text branch: Office mime types literally contain "openxmlformats".
      if (CONVERTIBLE.test(meta.mimeType)) {
        if (!writeEnabled()) {
          return jsonText({
            file: brief(meta),
            error: "conversion_unavailable",
            note: `Reading ${meta.mimeType} needs a temporary Google-Doc conversion, which requires DRIVE_MCP_WRITE to be enabled on the server. Open the webViewLink instead.`,
            webViewLink: meta.webViewLink,
          });
        }
        try {
          const raw = await readViaGoogleConversion(fileId);
          if (!raw.trim()) {
            return jsonText({ file: brief(meta), extractedAs: "google-ocr", content: "", note: "Google found no readable text in this file (blank, or an image with no legible text).", webViewLink: meta.webViewLink });
          }
          const { text, truncated } = capText(raw);
          return jsonText({ file: brief(meta), extractedAs: "google-ocr", truncated, content: text });
        } catch (e) {
          return jsonText({
            file: brief(meta),
            error: "conversion_failed",
            note: `Google could not convert this ${meta.mimeType}: ${e instanceof Error ? e.message : String(e)}`,
            webViewLink: meta.webViewLink,
          });
        }
      }
      // Genuinely text-ish uploads → decode as UTF-8. Anchored, because a loose /xml/ test matches
      // "open**xml**formats" and every .docx/.xlsx was being handed back as decoded ZIP bytes.
      if (TEXTUAL.test(meta.mimeType)) {
        const buf = await downloadBytes(fileId);
        const { text, truncated } = capText(buf.toString("utf8"));
        return jsonText({ file: brief(meta), extractedAs: meta.mimeType, truncated, content: text });
      }
      // Anything else — don't guess; point the caller at the right tool / the link.
      return jsonText({
        file: brief(meta),
        note: `Binary type ${meta.mimeType} isn't decoded by drive_read_file. Use drive_read_sheet for spreadsheets, drive_read_pdf for PDFs, or open the webViewLink.`,
        webViewLink: meta.webViewLink,
      });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_read_sheet",
    {
      title: "Read a spreadsheet (Google Sheet or Excel)",
      description:
        "Read a spreadsheet's tabs as CSV, live from Drive. Works for Google Sheets and uploaded Excel files (.xlsx/.xls) alike — EVERY tab is available for both. Input: fileId, optional sheet (tab name — omit to get all tabs), optional maxRows (default 500 per tab). Returns allTabs (every tab name in the workbook) plus per-tab { name, rowCount, csv, truncated }. If truncated is true you are seeing only the first maxRows rows — re-read with a higher maxRows before drawing a conclusion from a total. Asking for a tab that doesn't exist returns error=sheet_not_found with availableTabs. Good for a working, a payout register, a bank statement, a reconciliation.",
      inputSchema: {
        fileId: z.string().min(1).describe("the spreadsheet file id"),
        sheet: z.string().optional().describe("a specific tab name; omit for all tabs (.xlsx) / the sheet (Google Sheet)"),
        maxRows: z.number().int().min(1).max(20000).optional().describe("row cap per tab (default 500)"),
      },
    },
    async ({ fileId, sheet, maxRows }) => {
      const meta = await getMetadata(fileId);
      const cap = maxRows ?? 500;
      const clip = (csv: string) => {
        const rows = csv.split("\n");
        return rows.length > cap ? { csv: rows.slice(0, cap).join("\n"), rowCount: cap, truncated: true } : { csv, rowCount: rows.length, truncated: false };
      };

      // Google Sheet → export as XLSX, not CSV. CSV only ever returns the FIRST tab, so a request for
      // any other tab used to come back as tab 1's rows wearing the requested tab's name — silently
      // wrong data, which is worse than an error. XLSX carries every tab, and then falls through to the
      // same parser as an uploaded workbook. CSV stays as the fallback for sheets too large to export.
      let buf: Buffer;
      if (meta.mimeType === MIME.SHEET) {
        try {
          buf = await exportFile(fileId, MIME.XLSX);
        } catch (e) {
          if (!(e instanceof Error) || e.message !== "EXPORT_TOO_LARGE") throw e;
          const csvBuf = await exportFile(fileId, "text/csv");
          const c = clip(csvBuf.toString("utf8"));
          return jsonText({
            file: brief(meta),
            source: "google-sheet-csv-export",
            note: "Sheet too large to export as a workbook; this is the FIRST tab only. Other tabs are not available here — open webViewLink.",
            allTabs: null,
            tabs: [{ name: "(first tab)", ...c }],
          });
        }
      } else {
        // Uploaded Excel (or CSV) → parse with xlsx.
        buf = await downloadBytes(fileId);
      }
      let wb: XLSX.WorkBook;
      try {
        wb = XLSX.read(buf, { type: "buffer" });
      } catch {
        return jsonText({ file: brief(meta), error: "not_a_spreadsheet", note: `Could not parse ${meta.mimeType} as a spreadsheet.`, webViewLink: meta.webViewLink });
      }
      const names = sheet ? wb.SheetNames.filter((n) => n === sheet) : wb.SheetNames;
      if (sheet && names.length === 0) {
        return jsonText({ file: brief(meta), error: "sheet_not_found", availableTabs: wb.SheetNames });
      }
      const tabs = names.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        return { name, ...clip(csv) };
      });
      return jsonText({
        file: brief(meta),
        source: meta.mimeType === MIME.SHEET ? "google-sheet-xlsx-export" : "xlsx-parse",
        allTabs: wb.SheetNames,
        tabs,
      });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "drive_read_pdf",
    {
      title: "Read a PDF's text",
      description:
        "Extract the text of a PDF (by id), live from Drive. Returns the embedded text layer and page count — ideal for invoices, bank statements, agreements etc. that were saved as digital PDFs. If the PDF is a SCAN with no text layer, it automatically falls back to Google OCR and returns that text with extractedAs='google-ocr' — figures read by OCR should be sanity-checked against the image before being relied on. Input: fileId. For non-PDF files use drive_read_file / drive_read_sheet.",
      inputSchema: { fileId: z.string().min(1).describe("the PDF file id") },
    },
    async ({ fileId }) => {
      const meta = await getMetadata(fileId);
      if (meta.mimeType !== MIME.PDF && !/pdf/i.test(meta.name)) {
        return jsonText({ file: brief(meta), error: "not_a_pdf", note: `${meta.mimeType} is not a PDF — use drive_read_file or drive_read_sheet.` });
      }
      const buf = await downloadBytes(fileId);
      let pages: number | undefined;
      try {
        const out = await extractPdfText(buf);
        pages = out.pages;
        if (out.text.trim()) {
          const { text: t, truncated } = capText(out.text);
          return jsonText({ file: brief(meta), pages, hasText: true, truncated, content: t });
        }
        // No text layer → a scan. Hand it to OCR rather than reporting "OCR is required".
        return ocrPdfFallback(meta, pages);
      } catch {
        // A scan often fails to parse outright rather than parsing to empty — same fallback.
        return ocrPdfFallback(meta, pages);
      }
    },
  );

  // ================================================================================================
  // WRITE TOOLS (Phase 3) — registered ONLY when DRIVE_MCP_WRITE is enabled AND the SA is shared as
  // Editor. Read-only deployments never even expose these. No permanent delete: drive_trash_file is
  // recoverable. Every mutation is confined to the connected folder tree by the drive-client.
  // ================================================================================================
  if (writeEnabled()) {
    server.registerTool(
      "drive_create_folder",
      {
        title: "Create a new subfolder",
        description:
          "Create a new subfolder inside the connected Google Drive folder (or inside a given subfolder). Reflected live. Input: name, optional parentFolderId (must be inside the connected tree; omit for the root). Returns the new folder's metadata.",
        inputSchema: {
          name: z.string().min(1).describe("the new folder name"),
          parentFolderId: z.string().optional().describe("parent subfolder id; omit for the connected root"),
        },
      },
      async ({ name, parentFolderId }) => jsonText({ created: brief(await createFolder(name, parentFolderId)) }),
    );

    server.registerTool(
      "drive_upload_text_file",
      {
        title: "Create a new text/CSV file from content",
        description:
          "Create a NEW text-based file (plain text, CSV, JSON, Markdown) inside the connected folder from the content you provide. Reflected live. For binary files (PDF/xlsx/images) upload directly in Drive instead. Input: name, content (the file's text), optional mimeType (default text/plain — use text/csv for CSV), optional parentFolderId. Returns the new file's metadata.",
        inputSchema: {
          name: z.string().min(1).describe("the new file name (include an extension, e.g. notes.csv)"),
          content: z.string().describe("the text content of the file"),
          mimeType: z.string().optional().describe("e.g. text/plain, text/csv, application/json (default text/plain)"),
          parentFolderId: z.string().optional().describe("parent subfolder id; omit for the connected root"),
        },
      },
      async ({ name, content, mimeType, parentFolderId }) =>
        jsonText({ created: brief(await uploadTextFile(name, content, { mimeType, parentFolderId })) }),
    );

    server.registerTool(
      "drive_update_file_content",
      {
        title: "Replace an existing text file's content",
        description:
          "Overwrite the content of an existing uploaded text-based file (text/CSV/JSON/Markdown) with new content. Cannot overwrite Google-native Docs/Sheets/Slides (edit those in Drive). Reflected live. Input: fileId, content (the new full text), optional mimeType. Returns updated metadata.",
        inputSchema: {
          fileId: z.string().min(1).describe("the file id to overwrite"),
          content: z.string().describe("the new full text content"),
          mimeType: z.string().optional().describe("override the stored mime type if needed"),
        },
      },
      async ({ fileId, content, mimeType }) => jsonText({ updated: brief(await updateFileContent(fileId, content, mimeType)) }),
    );

    server.registerTool(
      "drive_rename_file",
      {
        title: "Rename a file or folder",
        description:
          "Rename a file or folder inside the connected tree. Reflected live. Input: fileId, newName. Returns updated metadata.",
        inputSchema: {
          fileId: z.string().min(1).describe("the file or folder id"),
          newName: z.string().min(1).describe("the new name"),
        },
      },
      async ({ fileId, newName }) => jsonText({ renamed: brief(await renameFile(fileId, newName)) }),
    );

    server.registerTool(
      "drive_move_file",
      {
        title: "Move a file or folder to another subfolder",
        description:
          "Move a file or folder into a different subfolder WITHIN the connected tree (cannot move things out of the connected folder). Reflected live. Input: fileId, targetFolderId (must be inside the connected tree). Returns updated metadata.",
        inputSchema: {
          fileId: z.string().min(1).describe("the file or folder id to move"),
          targetFolderId: z.string().min(1).describe("destination folder id, inside the connected tree"),
        },
      },
      async ({ fileId, targetFolderId }) => jsonText({ moved: brief(await moveFile(fileId, targetFolderId)) }),
    );

    server.registerTool(
      "drive_trash_file",
      {
        title: "Move a file or folder to Trash (recoverable)",
        description:
          "Move a file or folder to the Drive Trash. This is RECOVERABLE (restore from Drive Trash within ~30 days) — it is NOT a permanent delete, by design. Reflected live. Input: fileId. Returns the trashed item's metadata.",
        inputSchema: { fileId: z.string().min(1).describe("the file or folder id to move to Trash") },
      },
      async ({ fileId }) => jsonText({ trashed: brief(await trashFile(fileId)) }),
    );
  }

  return server;
}

/** Read-only Drive tools — always registered on the host server. */
export const DRIVE_READ_TOOLS = [
  "drive_list_files",
  "drive_search_files",
  "drive_latest_documents",
  "drive_read_file",
  "drive_read_sheet",
  "drive_read_pdf",
] as const;
/** Write tools — registered only when DRIVE_MCP_WRITE is enabled. */
export const DRIVE_WRITE_TOOLS = [
  "drive_create_folder",
  "drive_upload_text_file",
  "drive_update_file_content",
  "drive_rename_file",
  "drive_move_file",
  "drive_trash_file",
] as const;
/** Names actually exposed given the current write flag — used for the audit label + startup log. */
export function activeDriveTools(): string[] {
  return writeEnabled() ? [...DRIVE_READ_TOOLS, ...DRIVE_WRITE_TOOLS] : [...DRIVE_READ_TOOLS];
}
