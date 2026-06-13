import { NextResponse } from "next/server";
import { computeGstr3b } from "@/gst-core/gstr3b";
import { buildGstr3bWorkbook } from "@/lib/gstr3b-report";
import { gstr3bInputSchema, resolveRcm } from "@/lib/gstr3b-input";

export const runtime = "nodejs";

/** Recompute from the validated inputs and stream the final GSTR-3B report .xlsx. */
export async function POST(req: Request) {
  const parsed = gstr3bInputSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { input } = resolveRcm(parsed.data);
  const result = computeGstr3b(input);
  const buf = buildGstr3bWorkbook(result);
  const safePeriod = input.period.replace(/[^0-9A-Za-z_-]/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="Innovfix GSTR-3B ${safePeriod}.xlsx"`,
    },
  });
}
