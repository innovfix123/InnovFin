import { NextResponse } from "next/server";
import { z } from "zod";
import { buildGstr1Workbook } from "@/lib/gstr1-report";
import type { Gstr1Line, Gstr1Total } from "@/gst-core/gstr1";

export const runtime = "nodejs";

const lineSchema = z
  .object({
    app: z.string(),
    taxable: z.number(),
    igst: z.number().optional(),
    cgst: z.number(),
    sgst: z.number(),
    invoiceValueCalc: z.number(),
    invoiceValueActual: z.number(),
    roundOff: z.number(),
    hsn: z.union([z.number(), z.string()]).optional(),
    service: z.string().optional(),
    count: z.number(),
    serialMin: z.number().nullable().optional(),
    serialMax: z.number().nullable().optional(),
  })
  .passthrough();

const schema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  lines: z.array(lineSchema),
  total: z
    .object({
      taxable: z.number(),
      igst: z.number(),
      cgst: z.number(),
      sgst: z.number(),
      invoiceValueCalc: z.number(),
      invoiceValueActual: z.number(),
      roundOff: z.number(),
      count: z.number(),
    })
    .passthrough(),
});

/** Stream the GSTR-1 working .xlsx (Shoyab's filing-reference format) from computed sales. */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { period, lines, total } = parsed.data;
  const buf = buildGstr1Workbook(period, lines as unknown as Gstr1Line[], total as unknown as Gstr1Total);
  const safePeriod = period.replace(/[^0-9A-Za-z_-]/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="Innovfix GSTR-1 ${safePeriod}.xlsx"`,
    },
  });
}
