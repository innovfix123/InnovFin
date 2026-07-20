/**
 * buildDriveServer — the single source of truth for the Google Drive MCP toolset.
 *
 * This MCP is a LIVE BRIDGE to one shared Google Drive folder (DRIVE_FOLDER_ID). Google Drive is the
 * Single Source of Truth: every tool reads live from Drive on each call, so a new upload, an edit, a
 * rename, a move, or a delete is reflected immediately with no synchronization step. Nothing is
 * persisted and no file bytes are stored — only a 60s in-memory cache of the folder-tree's folder IDs
 * (pure metadata) to keep search cheap. File CONTENT is always fetched fresh from Drive.
 *
 * Six read-only tools: list_files, search_files, get_latest_documents, read_file, read_sheet, read_pdf.
 * Both transports import this factory: the stdio entry (server.ts) and the networked HTTPS route.
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
  MIME,
  type DriveFile,
} from "./drive-client";

/** Cap on how much extracted text any read_* tool returns, to keep responses sane. */
const TEXT_CAP = 200_000;

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

export function buildDriveServer(): McpServer {
  const server = new McpServer({ name: "drive", version: "1.0.0" });

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "list_files",
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
    "search_files",
    {
      title: "Search files by name or content",
      description:
        "Search the connected Google Drive folder (and all its subfolders) by file name AND full-text content. Reads live from Drive. Input: query (a word or phrase, e.g. 'Cashfree invoice May' or a vendor/GSTIN). Returns matching files with id, name, mimeType, size, modifiedTime, owner and webViewLink. Use read_file / read_sheet / read_pdf on a returned id to get the actual content. Full-text matching is Google's own Drive index (covers document bodies for supported types).",
      inputSchema: { query: z.string().min(1).describe("name or content to search for within the folder") },
    },
    async ({ query }) => {
      const files = await searchSubtree(query);
      return jsonText({ query, count: files.length, files: files.map(brief) });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "get_latest_documents",
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
    "read_file",
    {
      title: "Read a file's content as text",
      description:
        "Read the content of a single file (by id) as text, fetched live from Drive. Google Docs → plain text; Google Sheets → CSV (use read_sheet for multi-tab structure); Google Slides → text; plain-text/CSV/JSON uploads → their text; PDFs → routed to text extraction (or use read_pdf). Binary/office files (.xlsx/.docx/images) are NOT decoded here — use read_sheet for spreadsheets, read_pdf for PDFs. Google-native docs over 10 MB can't be exported by the API (Google limit); the tool then returns the webViewLink instead. Input: fileId (from list_files/search_files).",
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
        try {
          const { text, pages } = await extractPdfText(buf);
          if (!text.trim()) return jsonText({ file: brief(meta), pages, note: "No embedded text — likely a scanned/image PDF; OCR needed.", content: "" });
          const { text: t, truncated } = capText(text);
          return jsonText({ file: brief(meta), extractedAs: "pdf-text", pages, truncated, content: t });
        } catch {
          return jsonText({ file: brief(meta), note: "PDF could not be parsed (corrupt or scanned). Open it directly.", webViewLink: meta.webViewLink });
        }
      }
      // Plain-text-ish uploads → decode as UTF-8.
      if (/^text\/|json|xml|csv/i.test(meta.mimeType)) {
        const buf = await downloadBytes(fileId);
        const { text, truncated } = capText(buf.toString("utf8"));
        return jsonText({ file: brief(meta), extractedAs: meta.mimeType, truncated, content: text });
      }
      // Anything else — don't guess; point the caller at the right tool / the link.
      return jsonText({
        file: brief(meta),
        note: `Binary type ${meta.mimeType} isn't decoded by read_file. Use read_sheet for spreadsheets, read_pdf for PDFs, or open the webViewLink.`,
        webViewLink: meta.webViewLink,
      });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "read_sheet",
    {
      title: "Read a spreadsheet (Google Sheet or Excel)",
      description:
        "Read a spreadsheet's tabs as CSV, live from Drive. Works for Google Sheets (exported to CSV) and uploaded Excel files (.xlsx/.xls, parsed locally). Input: fileId, optional sheet (tab name — omit to get all tabs), optional maxRows (default 500 per tab). Returns per-tab { name, rowCount, csv }. For a Google Sheet only the FIRST tab is available via CSV export; for .xlsx every tab is available. Good for reading a working, a payout register, a reconciliation, etc.",
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

      // Google Sheet → CSV export (first sheet only, per the export API).
      if (meta.mimeType === MIME.SHEET) {
        const buf = await exportFile(fileId, "text/csv");
        const c = clip(buf.toString("utf8"));
        return jsonText({ file: brief(meta), source: "google-sheet-export", tabs: [{ name: sheet ?? "Sheet1", ...c }] });
      }

      // Uploaded Excel (or CSV) → parse with xlsx.
      const buf = await downloadBytes(fileId);
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
      return jsonText({ file: brief(meta), source: "xlsx-parse", allTabs: wb.SheetNames, tabs });
    },
  );

  // ------------------------------------------------------------------------------------------------
  server.registerTool(
    "read_pdf",
    {
      title: "Read a PDF's text",
      description:
        "Extract the text of a PDF (by id), live from Drive. Returns the embedded text layer and page count — ideal for invoices, bank statements, agreements etc. that were saved as digital PDFs. If the PDF is a scanned image with no text layer, it returns a note that OCR is required (no text). Input: fileId. For non-PDF files use read_file / read_sheet.",
      inputSchema: { fileId: z.string().min(1).describe("the PDF file id") },
    },
    async ({ fileId }) => {
      const meta = await getMetadata(fileId);
      if (meta.mimeType !== MIME.PDF && !/pdf/i.test(meta.name)) {
        return jsonText({ file: brief(meta), error: "not_a_pdf", note: `${meta.mimeType} is not a PDF — use read_file or read_sheet.` });
      }
      const buf = await downloadBytes(fileId);
      try {
        const { text, pages } = await extractPdfText(buf);
        if (!text.trim()) {
          return jsonText({ file: brief(meta), pages, hasText: false, note: "No embedded text layer — this looks like a scanned/image PDF; OCR is required.", content: "" });
        }
        const { text: t, truncated } = capText(text);
        return jsonText({ file: brief(meta), pages, hasText: true, truncated, content: t });
      } catch {
        return jsonText({ file: brief(meta), error: "parse_failed", note: "The PDF could not be parsed (corrupt or unsupported). Open it directly.", webViewLink: meta.webViewLink });
      }
    },
  );

  return server;
}

/** Tool names exposed by this server — used by the audit layer to validate/label calls. */
export const DRIVE_TOOLS = ["list_files", "search_files", "get_latest_documents", "read_file", "read_sheet", "read_pdf"] as const;
