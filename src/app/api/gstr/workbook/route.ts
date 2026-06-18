import { NextResponse } from "next/server";
import { APP_ORDER, parse, toLine, summarise, type Gstr1Line } from "@/gst-core/gstr1";
import { getConnector } from "@/lib/connectors";
import { computeGstr3b } from "@/gst-core/gstr3b";
import { parseGstr2b, type Gstr2bResult } from "@/lib/gstr2b";
import { parseRcmPivot } from "@/lib/bank-statement";
import { computeRcm, type RcmResult } from "@/gst-core/rcm";
import { bufferToSheets } from "@/lib/workbook";
import { buildFullWorkbook } from "@/lib/workbook-full";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Build the full multi-sheet "GST Working" workbook (Shoyab's format): re-fetches every
 * app's raw transactions for the per-app detail tabs, recomputes GSTR-1 + GSTR-3B, and
 * folds in the uploaded GSTR-2B (B2B detail) and bank/RCM pivot if provided.
 *
 * FormData: period, input (JSON of the GSTR-3B inputBody), optional `gstr2b` + `bank` files.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const period = String(form.get("period") || "");
  if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "bad period" }, { status: 400 });

  let input: { rcm?: { foreign: { taxable: number; igst: number }; rent: { taxable: number; cgst: number; sgst: number } }; itc2b?: { taxable: number; igst: number; cgst: number; sgst: number }; lateFee?: number; interest?: number } = {};
  try { input = JSON.parse(String(form.get("input") || "{}")); } catch { /* keep defaults */ }

  // 1) Re-fetch each configured app's raw transactions → per-app detail + GSTR-1.
  const lines: Gstr1Line[] = [];
  const perApp: { app: string; aoa: import("@/gst-core/gstr1").AOA }[] = [];
  for (const app of APP_ORDER) {
    const c = getConnector(app);
    if (!c || !c.isConfigured()) continue;
    try {
      const r = await c.fetch(period);
      perApp.push({ app, aoa: r.aoa });
      lines.push(toLine(app, parse(c.parserType, r.aoa), {}));
    } catch (e) {
      perApp.push({ app, aoa: [["error", e instanceof Error ? e.message : String(e)]] });
    }
  }
  const { total } = summarise(lines);

  // 2) Optional GSTR-2B (for the B2B detail sheet + ITC).
  let twoB: Gstr2bResult | null = null;
  const f2b = form.get("gstr2b");
  if (f2b instanceof File && f2b.size > 0) {
    try { twoB = parseGstr2b(bufferToSheets(Buffer.from(await f2b.arrayBuffer()))); } catch { twoB = null; }
  }

  // 3) Optional bank workbook → RCM detail (pivot path).
  let rcm: RcmResult | null = null;
  const fbank = form.get("bank");
  if (fbank instanceof File && fbank.size > 0) {
    try {
      const sheets = bufferToSheets(Buffer.from(await fbank.arrayBuffer()));
      for (const aoa of Object.values(sheets)) {
        let pivot: ReturnType<typeof parseRcmPivot> = [];
        try { pivot = parseRcmPivot(aoa); } catch { pivot = []; }
        if (pivot.length > 0) { rcm = computeRcm(pivot); break; }
      }
    } catch { rcm = null; }
  }

  // 4) Resolve 3B inputs — prefer parsed files, fall back to the cockpit totals.
  const rcmInput = rcm
    ? { foreign: { taxable: rcm.foreign.taxable, igst: rcm.foreign.igst }, rent: { taxable: rcm.rent.taxable, cgst: rcm.rent.cgst, sgst: rcm.rent.sgst } }
    : input.rcm ?? { foreign: { taxable: 0, igst: 0 }, rent: { taxable: 0, cgst: 0, sgst: 0 } };
  const itcInput = twoB
    ? { taxable: twoB.itcAvailable.taxable, igst: twoB.itcAvailable.igst, cgst: twoB.itcAvailable.cgst, sgst: twoB.itcAvailable.sgst }
    : input.itc2b ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0 };

  const g3 = computeGstr3b({
    period,
    outward: { taxable: total.taxable, cgst: total.cgst, sgst: total.sgst },
    rcm: rcmInput,
    itc2b: itcInput,
    lateFee: input.lateFee,
    interest: input.interest,
  });

  const buf = buildFullWorkbook({ period, lines, total, gstr3b: g3, perApp, rcm, twoB });
  const safe = period.replace(/[^0-9A-Za-z_-]/g, "");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="Innovfix GST Working ${safe}.xlsx"`,
    },
  });
}
