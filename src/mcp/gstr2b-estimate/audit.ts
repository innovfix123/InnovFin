/**
 * Access/audit log for the networked Estimated GSTR-2B endpoint. Mirror of the other MCPs'
 * audit.ts, writing to GSTR-2B-est-mcp/logs/access.jsonl (a gitignored working dir).
 *
 * Append-only JSONL (the source data is read-only — audit trails are never written to a database).
 * Also mirrored to stderr so it lands in `pm2 logs innovfin`.
 *
 * We record the *shape* of a call (tool name, period, cut-off, bucket, whether a workbook was
 * supplied) — never invoice amounts, vendor names, GSTINs, or token secrets.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const LOG_DIR = resolve(REPO_ROOT, "GSTR-2B-est-mcp/logs");
const LOG_FILE = resolve(LOG_DIR, "access.jsonl");

export interface AuditEntry {
  ts: string;                     // ISO-8601 UTC
  event: "call" | "auth_fail" | "error";
  user: string;                   // principal label, or "anonymous"
  tokenFp?: string;               // non-secret token fingerprint (present when a token was supplied)
  ip: string;                     // client IP (X-Forwarded-For, set by nginx)
  method?: string;                // JSON-RPC method (e.g. "tools/call", "initialize")
  tool?: string;                  // tool name for tools/call
  args?: Record<string, unknown>; // WHITELISTED, non-sensitive call shape only (see safeArgs)
  status: number;                 // HTTP status returned
  ms: number;                     // handler duration
  reason?: string;                // auth_fail / error detail
}

/**
 * Reduce raw tool arguments to a summary safe to persist: the period, the received_to cut-off and
 * bucket (month/date strings), and whether a workbook was passed — never file contents or amounts.
 */
export function safeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.period === "string") out.period = a.period;
  if (typeof a.received_to === "string") out.received_to = a.received_to;
  if (typeof a.bucket === "string") out.bucket = a.bucket;
  if (typeof a.file === "string") out.hasFile = true;
  if (typeof a.file_base64 === "string") out.hasFileB64 = true;
  // Drive tools: identifiers and sizes only — never file content, and never the search query text
  // (which can itself carry a vendor name or GSTIN).
  if (typeof a.fileId === "string") out.fileId = a.fileId;
  if (typeof a.folderId === "string") out.folderId = a.folderId;
  if (typeof a.parentFolderId === "string") out.parentFolderId = a.parentFolderId;
  if (typeof a.targetFolderId === "string") out.targetFolderId = a.targetFolderId;
  if (typeof a.sheet === "string") out.sheet = a.sheet;
  if (typeof a.query === "string") out.queryLen = a.query.length;
  if (typeof a.content === "string") out.contentLen = a.content.length;
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry. Never throws — an audit-write failure must not take down the request. */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("gstr2b-estimate audit: file append failed:", e);
  }
  console.error("gstr2b-estimate audit", line);
}
