import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getAttachment } from "@/lib/invoice-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams the ORIGINAL document (PDF/image bytes, or text) so the reviewer can see the source. */
export async function GET(_req: Request, ctx: { params: Promise<{ docId: string }> }) {
  if (!(await getSessionEmail())) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { docId } = await ctx.params;
  try {
    const att = await getAttachment(docId);
    if (att.error) return NextResponse.json({ error: att.error }, { status: 404 });
    if (att.too_large) return NextResponse.json({ error: "Document too large to preview." }, { status: 413 });

    const safeName = (att.filename || "document").replace(/["\r\n]/g, "");
    if (att.is_text) {
      return new NextResponse(att.text ?? "", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const bytes = new Uint8Array(Buffer.from(att.content_base64 ?? "", "base64"));
    return new NextResponse(bytes, {
      headers: {
        "content-type": att.mime_type || "application/octet-stream",
        "content-disposition": `inline; filename="${safeName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
