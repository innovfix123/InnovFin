import { NextResponse } from "next/server";
import { bufferToAOA } from "@/lib/workbook";
import {
  parse, toLine, summarise,
  APP_ORDER, APP_DEFAULTS,
  type ParserType, type Gstr1Line,
} from "@/gst-core/gstr1";

// Needs the Node runtime (Buffer + SheetJS), not Edge.
export const runtime = "nodejs";

/**
 * POST multipart/form-data:
 *   period            return month, e.g. "2026-05"
 *   file:<App>        the uploaded CSV/XLSX for each app
 *   type:<App>        optional parser override (invoicewise|razorpay|phonepe|cashfree)
 *   hsn:<App>         optional HSN override
 * Returns the GSTR-1 working: per-app lines, HSN-wise summary (Table 12), total, errors.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const period = (form.get("period") as string) || "";

  const lines: Gstr1Line[] = [];
  const errors: Record<string, string> = {};

  for (const app of APP_ORDER) {
    const file = form.get(`file:${app}`);
    if (!(file instanceof File) || file.size === 0) continue;

    const typeRaw = form.get(`type:${app}`);
    const type = (typeof typeRaw === "string" && typeRaw ? typeRaw : APP_DEFAULTS[app].type) as ParserType;
    const hsnRaw = form.get(`hsn:${app}`);
    const hsn = typeof hsnRaw === "string" && hsnRaw.trim() ? Number(hsnRaw) : undefined;

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const aoa = bufferToAOA(buf);
      const meas = parse(type, aoa);
      lines.push(toLine(app, meas, hsn != null && !Number.isNaN(hsn) ? { hsn } : {}));
    } catch (e) {
      errors[app] = e instanceof Error ? e.message : String(e);
    }
  }

  const { hsnRows, total } = summarise(lines);
  return NextResponse.json({ period, lines, hsnRows, total, errors });
}
