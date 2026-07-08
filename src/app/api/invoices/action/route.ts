import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { approveInvoice, rejectInvoice, setInvoiceField, type InvoiceSummary } from "@/lib/invoice-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  docId?: string;
  action?: "approve" | "reject" | "set_field" | "edit_approve";
  field?: string;
  value?: string | number;
  fields?: Record<string, string | number>;
  note?: string;
};

/**
 * Human review actions, wired 1:1 to the MCP review tools:
 *   approve       → approve_invoice
 *   reject        → reject_invoice
 *   set_field     → set_invoice_field (one field, re-validates)
 *   edit_approve  → set_invoice_field for each edited field, then approve_invoice (fix → accept)
 */
export async function POST(req: Request) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { docId, action, field, value, fields, note } = body;
  if (!docId || !action) {
    return NextResponse.json({ error: "docId and action are required." }, { status: 400 });
  }

  try {
    let invoice: InvoiceSummary;
    if (action === "approve") {
      invoice = await approveInvoice(docId, note ?? "");
    } else if (action === "reject") {
      invoice = await rejectInvoice(docId, note ?? "");
    } else if (action === "set_field") {
      if (!field) return NextResponse.json({ error: "field is required for set_field." }, { status: 400 });
      invoice = await setInvoiceField(docId, field, String(value ?? ""));
    } else if (action === "edit_approve") {
      const edits = Object.entries(fields ?? {});
      for (const [f, v] of edits) {
        if (f) invoice = await setInvoiceField(docId, f, String(v ?? ""));
      }
      invoice = await approveInvoice(docId, note ?? "");
    } else {
      return NextResponse.json({ error: `Unknown action ${String(action)}.` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, invoice });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
