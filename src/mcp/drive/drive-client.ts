/**
 * Folder-scoped Google Drive v3 REST client for the Drive MCP.
 *
 * SINGLE SOURCE OF TRUTH: every method reads live from Drive on each call — nothing is persisted, no
 * file bytes are stored. The only cache is a 60s in-memory list of the folder-subtree's folder IDs
 * (pure metadata), so we don't re-walk the tree on every search. That satisfies the "may cache
 * metadata, never content" rule while guaranteeing freshness stays within ~60s for the *shape* of the
 * tree and fully live for file contents/metadata.
 *
 * SCOPING: the MCP is bound to ONE folder (DRIVE_FOLDER_ID). Reads are constrained to that folder and
 * its descendants — the client cannot see anything outside the tree, by construction.
 *
 * Dependency-free: plain fetch + the SA token from google-auth.ts. supportsAllDrives/​
 * includeItemsFromAllDrives are always set so it works whether the folder lives in My Drive (shared
 * with the SA) or in a Shared Drive.
 */
import { getAccessToken } from "./google-auth";
import { envVar } from "./env";

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_RESULTS = 1000; // hard cap on rows any one tool returns
const FOLDER_CACHE_TTL_MS = 60_000;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  kind: "file" | "folder";
  size: number | null;
  createdTime?: string;
  modifiedTime?: string;
  modifiedBy?: string;
  owner?: string;
  webViewLink?: string;
  parents?: string[];
  md5Checksum?: string;
  trashed?: boolean;
  isShortcut: boolean;
  shortcutTarget?: string;
}

/** The compact metadata field set requested from Drive for every file. */
const FILE_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,md5Checksum,trashed," +
  "owners(displayName,emailAddress),lastModifyingUser(displayName),shortcutDetails(targetId,targetMimeType)";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

export function rootFolderId(): string {
  const id = envVar("DRIVE_FOLDER_ID");
  if (!id) throw new Error("Drive MCP: DRIVE_FOLDER_ID is not configured in .env");
  return id.trim();
}

// ---------------------------------------------------------------------------------------------------
// Low-level HTTP with truncated exponential backoff on 429/403-rateLimit/5xx.
// ---------------------------------------------------------------------------------------------------
async function driveFetch(path: string, init?: RequestInit, attempt = 0): Promise<Response> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 5) {
    // 403 is only retryable when it's a rate-limit reason; peek without consuming for other codes.
    if (res.status === 403) {
      const txt = await res.clone().text().catch(() => "");
      if (!/rateLimitExceeded|userRateLimitExceeded|quota/i.test(txt)) return res;
    }
    const backoff = Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 400);
    await new Promise((r) => setTimeout(r, backoff));
    return driveFetch(path, init, attempt + 1);
  }
  return res;
}

async function driveJson<T>(path: string): Promise<T> {
  const res = await driveFetch(path);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status} on ${path.split("?")[0]}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const commonListParams = (): string =>
  "supportsAllDrives=true&includeItemsFromAllDrives=true&spaces=drive&corpora=allDrives";

function shape(f: Record<string, unknown>): DriveFile {
  const owners = f.owners as Array<{ displayName?: string; emailAddress?: string }> | undefined;
  const lmu = f.lastModifyingUser as { displayName?: string } | undefined;
  const sc = f.shortcutDetails as { targetId?: string; targetMimeType?: string } | undefined;
  const mimeType = String(f.mimeType ?? "");
  return {
    id: String(f.id),
    name: String(f.name ?? ""),
    mimeType,
    kind: mimeType === FOLDER_MIME ? "folder" : "file",
    size: f.size != null ? Number(f.size) : null,
    createdTime: f.createdTime as string | undefined,
    modifiedTime: f.modifiedTime as string | undefined,
    modifiedBy: lmu?.displayName,
    owner: owners?.[0]?.displayName ?? owners?.[0]?.emailAddress,
    webViewLink: f.webViewLink as string | undefined,
    parents: f.parents as string[] | undefined,
    md5Checksum: f.md5Checksum as string | undefined,
    trashed: f.trashed as boolean | undefined,
    isShortcut: mimeType === "application/vnd.google-apps.shortcut",
    shortcutTarget: sc?.targetId,
  };
}

/** Escape a value for a Drive query string literal (single-quote delimited). */
const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function listPage(q: string, opts: { orderBy?: string; pageSize?: number; pageToken?: string }): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    q,
    fields: LIST_FIELDS,
    pageSize: String(opts.pageSize ?? 100),
  });
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  const json = await driveJson<{ files?: Record<string, unknown>[]; nextPageToken?: string }>(
    `/files?${params.toString()}&${commonListParams()}`,
  );
  return { files: (json.files ?? []).map(shape), nextPageToken: json.nextPageToken };
}

/** List every page of a query, up to MAX_RESULTS rows. */
async function listAll(q: string, orderBy?: string, cap = MAX_RESULTS): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const { files, nextPageToken } = await listPage(q, { orderBy, pageSize: 200, pageToken });
    out.push(...files);
    pageToken = nextPageToken;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

// ---------------------------------------------------------------------------------------------------
// Subtree scoping — cache the set of folder IDs under the root for 60s so search/latest can constrain
// to the whole tree without re-walking every call.
// ---------------------------------------------------------------------------------------------------
let folderSetCache: { ids: string[]; at: number } | null = null;

async function descendantFolderIds(): Promise<string[]> {
  if (folderSetCache && Date.now() - folderSetCache.at < FOLDER_CACHE_TTL_MS) return folderSetCache.ids;
  const root = rootFolderId();
  const all = new Set<string>([root]);
  let frontier = [root];
  // Bounded BFS: cap total folders so a pathological tree can't blow up the query.
  while (frontier.length && all.size < 500) {
    const next: string[] = [];
    // Query children-that-are-folders for up to ~40 parents at a time (query length safety).
    for (let i = 0; i < frontier.length; i += 40) {
      const batch = frontier.slice(i, i + 40);
      const parentClause = batch.map((id) => `'${esc(id)}' in parents`).join(" or ");
      const q = `mimeType='${FOLDER_MIME}' and trashed=false and (${parentClause})`;
      const kids = await listAll(q, undefined, 500);
      for (const k of kids) {
        if (!all.has(k.id)) {
          all.add(k.id);
          next.push(k.id);
        }
      }
    }
    frontier = next;
  }
  folderSetCache = { ids: [...all], at: Date.now() };
  return folderSetCache.ids;
}

/** OR-clause constraining results to any folder in the subtree, chunked to keep the query bounded. */
async function subtreeParentClauses(): Promise<string[]> {
  const ids = await descendantFolderIds();
  const chunks: string[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    chunks.push(ids.slice(i, i + 40).map((id) => `'${esc(id)}' in parents`).join(" or "));
  }
  return chunks;
}

/** Merge + de-dup files from multiple chunked queries, keeping the first occurrence. */
function dedup(files: DriveFile[]): DriveFile[] {
  const seen = new Set<string>();
  const out: DriveFile[] = [];
  for (const f of files) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Public API used by the MCP tools.
// ---------------------------------------------------------------------------------------------------

/** True if `folderId` is the root or a descendant folder of it (guards drill-down requests). */
export async function isInScope(folderId: string): Promise<boolean> {
  return (await descendantFolderIds()).includes(folderId);
}

/** Direct children of a folder (default: the root). Includes subfolders. */
export async function listChildren(folderId?: string): Promise<DriveFile[]> {
  const target = folderId?.trim() || rootFolderId();
  if (!(await isInScope(target))) {
    throw new Error(`Drive MCP: folder ${target} is outside the configured folder subtree`);
  }
  const q = `'${esc(target)}' in parents and trashed=false`;
  return listAll(q, "folder,name");
}

/** Full-text + name search across the whole subtree. */
export async function searchSubtree(text: string): Promise<DriveFile[]> {
  const term = esc(text.trim());
  const chunks = await subtreeParentClauses();
  const all: DriveFile[] = [];
  for (const clause of chunks) {
    const q = `trashed=false and (${clause}) and (name contains '${term}' or fullText contains '${term}')`;
    all.push(...(await listAll(q, undefined)));
  }
  return dedup(all).slice(0, MAX_RESULTS);
}

/** Most-recently-modified files across the subtree. */
export async function latestInSubtree(limit: number): Promise<DriveFile[]> {
  const chunks = await subtreeParentClauses();
  const all: DriveFile[] = [];
  for (const clause of chunks) {
    const q = `trashed=false and mimeType!='${FOLDER_MIME}' and (${clause})`;
    all.push(...(await listAll(q, "modifiedTime desc", Math.max(limit, 50))));
  }
  return dedup(all)
    .sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))
    .slice(0, limit);
}

/** Live metadata for one file — with an in-scope check so a raw ID can't reach outside the tree. */
export async function getMetadata(fileId: string): Promise<DriveFile> {
  const json = await driveJson<Record<string, unknown>>(
    `/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
  );
  const file = shape(json);
  const parents = file.parents ?? [];
  const scoped = await descendantFolderIds();
  if (!parents.some((p) => scoped.includes(p))) {
    throw new Error(`Drive MCP: file ${fileId} is not inside the configured folder`);
  }
  return file;
}

/** Download raw bytes of an uploaded (non-Google-native) file. */
export async function downloadBytes(fileId: string): Promise<Buffer> {
  await getMetadata(fileId); // enforce scope before fetching bytes
  const res = await driveFetch(`/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status} downloading ${fileId}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Export a Google-native doc (Docs/Sheets/Slides) to a target MIME. Capped at 10 MB by Google. */
export async function exportFile(fileId: string, mimeType: string): Promise<Buffer> {
  await getMetadata(fileId); // enforce scope
  const res = await driveFetch(
    `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}&supportsAllDrives=true`,
  );
  if (res.status === 403) {
    const txt = await res.text().catch(() => "");
    if (/exportSizeLimitExceeded|too large/i.test(txt)) {
      throw new Error("EXPORT_TOO_LARGE");
    }
    throw new Error(`Drive API 403 exporting ${fileId}: ${txt.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status} exporting ${fileId}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export const MIME = {
  FOLDER: FOLDER_MIME,
  DOC: "application/vnd.google-apps.document",
  SHEET: "application/vnd.google-apps.spreadsheet",
  SLIDES: "application/vnd.google-apps.presentation",
  PDF: "application/pdf",
} as const;
export { MAX_RESULTS };
