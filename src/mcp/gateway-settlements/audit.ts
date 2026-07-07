/**
 * Access/audit log for the networked Gateway Settlements endpoint. Mirror of Hima/Only Care's
 * audit.ts, writing to Gateway-Settlements-mcp/logs/access.jsonl.
 *
 * Append-only JSONL (the source data is read-only — audit trails are never written to a database).
 * Also mirrored to stderr so it lands in `pm2 logs innovfin`.
 *
 * We record the *shape* of a call (tool name, period, which app/gateway) — never fee values, PANs,
 * bank UTRs, or token secrets.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

const LOG_DIR = resolve(REPO_ROOT, "Gateway-Settlements-mcp/logs");
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
 * Reduce raw tool arguments to a summary safe to persist: period (a month string), app, gateway,
 * and boolean flags. Anything unrecognised is dropped.
 */
export function safeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.period === "string") out.period = a.period;
  if (typeof a.app === "string") out.app = a.app;
  if (typeof a.gateway === "string") out.gateway = a.gateway;
  if (typeof a.includeRows === "boolean") out.includeRows = a.includeRows;
  // Manual/invoice/carry-forward inputs → counts only (amounts + invoice refs are not persisted).
  if (Array.isArray(a.invoiceLines)) out.invoiceLineCount = a.invoiceLines.length;
  if (Array.isArray(a.manualLines)) out.manualLineCount = a.manualLines.length;
  if (Array.isArray(a.carryForward)) out.carryForwardCount = a.carryForward.length;
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry. Never throws — an audit-write failure must not take down the request. */
export function audit(entry: AuditEntry): void {
  const line = JSON.stringify(entry);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error("gateway-settlements audit: file append failed:", e);
  }
  console.error("gateway-settlements audit", line);
}
