import { NextResponse } from "next/server";
import { bufferToSheets } from "@/lib/workbook";
import { parseGstr2b } from "@/lib/gstr2b";

export const runtime = "nodejs";

/** Upload a GST-portal GSTR-2B workbook → extract Table 4(A)(5) ITC (+ B2B invoices). */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Upload the GSTR-2B Excel as 'file'." }, { status: 400 });
  }
  try {
    const sheets = bufferToSheets(Buffer.from(await file.arrayBuffer()));
    const r = parseGstr2b(sheets);
    return NextResponse.json({
      itcAvailable: r.itcAvailable,
      itcReversed: r.itcReversed,
      itcIneligible: r.itcIneligible,
      invoiceCount: r.invoices.length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
