/**
 * Server-side client for the local invoice-intelligence MCP (Python FastMCP on 127.0.0.1:8765).
 *
 * The invoice review UI's API routes call these — reusing the SAME MCP tools Claude uses
 * (review_queue / get_invoice / get_attachment / approve_invoice / reject_invoice /
 * set_invoice_field) so the browser workflow and the agent workflow stay in lock-step.
 *
 * FastMCP returns a tool's value in `structuredContent`: list-returning tools wrap it as
 * `{ result: [...] }`; dict-returning tools return the object directly. We normalise both.
 */
import { upstreamUrl } from "@/mcp/invoice-intelligence/proxy";
import { envVar } from "@/mcp/invoice-intelligence/env";

type JsonRpcResponse = { result?: unknown; error?: { message?: string } };
type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown> | null;
};

async function rpc(method: string, params: unknown): Promise<unknown> {
  const token = envVar("INVOICE_MCP_TOKEN"); // localhost hardening secret, if configured
  const res = await fetch(upstreamUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`invoice MCP ${method}: HTTP ${res.status}`);
  const data = (await res.json()) as JsonRpcResponse;
  if (data.error) throw new Error(`invoice MCP ${method}: ${data.error.message ?? "error"}`);
  return data.result;
}

/** Call a tool and return its JSON value, unwrapping FastMCP's content/structuredContent. */
export async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await rpc("tools/call", { name, arguments: args })) as ToolResult;
  const sc = result.structuredContent;
  if (sc && typeof sc === "object") {
    return ("result" in sc ? (sc as Record<string, unknown>).result : sc) as T;
  }
  const items = (result.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => JSON.parse(c.text as string) as unknown);
  return (items.length === 1 ? items[0] : items) as T;
}

export type InvoiceSummary = {
  doc_id: string;
  status: string;
  vendor_name: string | null;
  vendor_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  currency: string | null;
  sender: string | null;
  received_date: string | null;
};

export type ReviewItem = InvoiceSummary & {
  reasons: string[];
  confidence: number | null;
  low_confidence_fields: string[];
  doc_type: string | null;
  filename: string | null;
};

export type Attachment = {
  doc_id: string;
  filename: string;
  mime_type: string;
  doc_type: string;
  size: number;
  is_text?: boolean;
  content_base64?: string;
  text?: string;
  too_large?: boolean;
  error?: string;
};

export const reviewQueue = () => callTool<ReviewItem[]>("review_queue", { limit: 500 });
export const acceptedList = () => callTool<InvoiceSummary[]>("search_invoices", { status: "accepted", limit: 500 });
export const getInvoice = (docId: string) => callTool<Record<string, unknown>>("get_invoice", { doc_id: docId });
export const getAttachment = (docId: string) => callTool<Attachment>("get_attachment", { doc_id: docId });
export const approveInvoice = (invoice: string, note = "") => callTool<InvoiceSummary>("approve_invoice", { invoice, note });
export const rejectInvoice = (invoice: string, note = "") => callTool<InvoiceSummary>("reject_invoice", { invoice, note });
export const setInvoiceField = (invoice: string, field: string, value: string) =>
  callTool<InvoiceSummary>("set_invoice_field", { invoice, field, value });
