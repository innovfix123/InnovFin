/**
 * Access/audit log for the networked Hima TDS endpoint. Mirror of Only Care's audit.ts, writing to
 * Hima-TDS-mcp/logs/access.jsonl.
 *
 * This endpoint serves creator PANs, so every call is recorded: who, which tool, when, outcome.
 * Append-only JSONL (the DB is read-only — audit trails are never written to a database). Also
 * mirrored to stderr so it lands in `pm2 logs innovfin`.
 *
 * HARD RULE: this log must never contain a PAN or a token secret. We record the *shape* of a call
 * (tool name, period, how many creators/PANs were passed) — never the PAN values or results.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const LOG_DIR = resolve(REPO_ROOT, "Hima-TDS-mcp/logs");
const LOG_FILE = resolve(LOG_DIR, "access.jsonl");

export interface AuditEntry {
  ts: string;                    // ISO-8601 UTC
  event: "call" | "auth_fail" | "error";
  user: string;                  // principal label, or "anonymous"
  tokenFp?: string;              // non-secret token fingerprint (present when a token was supplied)
  ip: string;                    // client IP (X-Forwarded-For, set by nginx)
  method?: string;               // JSON-RPC method (e.g. "tools/call", "initialize")
  tool?: string;                 // tool name for tools/call
  args?: Record<string, unknown>; // WHITELISTED, non-PII call shape only (see safeArgs)
  status: number;                // HTTP status returned
  ms: number;                    // handler duration
  reason?: string;               // auth_fail / error detail
}

/**
 * Reduce raw tool arguments to a PII-free summary safe to persist.
 * Allowed: period (a month string), writeWorkbook / withVerification (flags). PAN- and id-bearing
 * arrays (pans, tracesRecords, creatorIds) are reduced to counts. Anything unrecognised is dropped.
 */
export function safeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.period === "string") out.period = a.period;
  if (typeof a.writeWorkbook === "boolean") out.writeWorkbook = a.writeWorkbook;
  if (typeof a.withVerification === "boolean") out.withVerification = a.withVerification;
  if (Array.isArray(a.pans)) out.panCount = a.pans.length;
  if (Array.isArray(a.creatorIds)) out.creatorIdCount = a.creatorIds.length;
  if (Array.isArray(a.tracesRecords)) out.tracesRecordCount = a.tracesRecords.length;
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry. Never throws — an audit-write failure must not take down the request. */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("hima-tds audit: file append failed:", e);
  }
  // Ops mirror — pm2 captures stderr.
  console.error("hima-tds audit", line);
}
