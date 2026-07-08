/**
 * Access/audit log for the networked invoice-intelligence endpoint. Mirror of Hima's audit.ts,
 * writing to invoice-intelligence/logs/access.jsonl.
 *
 * Every call is recorded: who, which tool, when, outcome. Append-only JSONL (no DB write). Also
 * mirrored to stderr so it lands in `pm2 logs innovfin`.
 *
 * RULE: record the *shape* of a call (tool name, filters used, the invoice/doc target acted on) —
 * never free-text search queries, corrected field VALUES, or review notes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const LOG_DIR = resolve(REPO_ROOT, "invoice-intelligence/logs");
const LOG_FILE = resolve(LOG_DIR, "access.jsonl");

export interface AuditEntry {
  ts: string;                    // ISO-8601 UTC
  event: "call" | "auth_fail" | "error";
  user: string;                  // principal label, or "anonymous"
  tokenFp?: string;              // non-secret token fingerprint (present when a token was supplied)
  ip: string;                    // client IP (X-Forwarded-For, set by nginx)
  method?: string;               // JSON-RPC method (e.g. "tools/call", "initialize")
  tool?: string;                 // tool name for tools/call
  args?: Record<string, unknown>; // WHITELISTED, non-sensitive call shape only (see safeArgs)
  status: number;                // HTTP status returned
  ms: number;                    // handler duration
  reason?: string;               // auth_fail / error detail
}

/**
 * Reduce raw tool arguments to a summary safe to persist. Allowed verbatim: status, limit, the
 * FIELD NAME a human corrected, and the opaque invoice/doc target acted on. Free-text search,
 * corrected VALUES, and notes are reduced to presence flags or dropped. Anything unrecognised
 * is dropped.
 */
export function safeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.status === "string") out.status = a.status;
  if (typeof a.limit === "number") out.limit = a.limit;
  if (typeof a.field === "string") out.field = a.field;                 // which field was corrected (not its value)
  if (typeof a.doc_id === "string" && a.doc_id) out.docId = a.doc_id;   // opaque sha256 lookup target
  if (typeof a.invoice === "string" && a.invoice) out.target = a.invoice; // doc_id or invoice# acted on
  if (typeof a.text === "string" && a.text) out.hasText = true;         // never log the query text
  if (typeof a.vendor_gstin === "string" && a.vendor_gstin) out.byVendorGstin = true;
  if (typeof a.invoice_number === "string" && a.invoice_number) out.byInvoiceNumber = true;
  if (typeof a.sender === "string" && a.sender) out.bySender = true;
  if (a.date_from || a.date_to || a.received_from || a.received_to) out.dateFilter = true;
  if (a.min_total != null || a.max_total != null) out.amountFilter = true;
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry. Never throws — an audit-write failure must not take down the request. */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("invoice-intelligence audit: file append failed:", e);
  }
  // Ops mirror — pm2 captures stderr.
  console.error("invoice-intelligence audit", line);
}
