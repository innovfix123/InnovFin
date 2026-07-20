/**
 * Access/audit log for the networked Google Drive endpoint. Mirror of gateway-settlements/audit.ts,
 * writing to Drive-mcp/logs/access.jsonl.
 *
 * Append-only JSONL, also mirrored to stderr so it lands in `pm2 logs innovfin`. We record the *shape*
 * of a call (tool name, and a query length / whether a fileId was supplied) — never file names, file
 * content, folder contents, or token secrets. A file id is opaque and not itself sensitive, but we log
 * only whether one was present, not the id, to keep the trail minimal.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const LOG_DIR = resolve(REPO_ROOT, "Drive-mcp/logs");
const LOG_FILE = resolve(LOG_DIR, "access.jsonl");

export interface AuditEntry {
  ts: string;
  event: "call" | "auth_fail" | "error";
  user: string;
  tokenFp?: string;
  ip: string;
  method?: string;
  tool?: string;
  args?: Record<string, unknown>;
  status: number;
  ms: number;
  reason?: string;
}

/**
 * Reduce raw tool arguments to a non-sensitive summary: whether a fileId/folderId was supplied,
 * the length of a search query (not the query itself), and numeric limits. Nothing that reveals
 * document names or contents is persisted.
 */
export function safeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.fileId === "string") out.hasFileId = true;
  if (typeof a.folderId === "string") out.hasFolderId = true;
  if (typeof a.query === "string") out.queryLen = a.query.length;
  if (typeof a.sheet === "string") out.hasSheet = true;
  if (typeof a.limit === "number") out.limit = a.limit;
  if (typeof a.maxRows === "number") out.maxRows = a.maxRows;
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry. Never throws — an audit-write failure must not take down the request. */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("drive audit: file append failed:", e);
  }
  console.error("drive audit", line);
}
