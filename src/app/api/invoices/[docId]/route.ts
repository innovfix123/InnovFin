import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getInvoice } from "@/lib/invoice-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The full canonical record for one invoice (fields, provenance, validation reasons, text). */
export async function GET(_req: Request, ctx: { params: Promise<{ docId: string }> }) {
  if (!(await getSessionEmail())) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { docId } = await ctx.params;
  try {
    const rec = await getInvoice(docId);
    if (rec && typeof rec === "object" && "error" in rec) {
      return NextResponse.json(rec, { status: 404 });
    }
    return NextResponse.json(rec);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
