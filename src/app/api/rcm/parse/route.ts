import { NextResponse } from "next/server";
import { bufferToSheets } from "@/lib/workbook";
import { parseRcmPivot, parseBankStatement } from "@/lib/bank-statement";
import { computeRcm, classifyVendor } from "@/gst-core/rcm";
import { categorizeExpensesLLM, type ExpenseToCategorize } from "@/lib/rcm-llm";

export const runtime = "nodejs";
export const maxDuration = 120;

const AI_CAP = 250; // bound the AI batch (cost/latency)

/**
 * Upload bank data → RCM (Table 3.1(d)).
 *  1. If the workbook has a categorised "RCM Applicable" pivot, use it — deterministic &
 *     validated (the Master Reference's source of truth).
 *  2. Otherwise treat it as raw bank statements: keyword-classify the narrations, and send
 *     the leftovers to the AI for a SUGGESTED categorisation → review queue (confirm before filing).
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Upload a bank statement or RCM pivot as 'file'." }, { status: 400 });
  }

  let sheets: Record<string, ReturnType<typeof bufferToSheets>[string]>;
  try {
    sheets = bufferToSheets(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  // 1) Pivot path — reliable, validated.
  for (const aoa of Object.values(sheets)) {
    let pivot: ReturnType<typeof parseRcmPivot> = [];
    try { pivot = parseRcmPivot(aoa); } catch { pivot = []; }
    if (pivot.length > 0) {
      const r = computeRcm(pivot);
      return NextResponse.json({
        source: "pivot",
        foreign: { taxable: r.foreign.taxable, igst: r.foreign.igst },
        rent: { taxable: r.rent.taxable, cgst: r.rent.cgst, sgst: r.rent.sgst },
        review: [],
        excluded: r.excluded.map((l) => l.vendor),
        note: `Read ${pivot.length} RCM-flagged rows from your categorised pivot.`,
      });
    }
  }

  // 2) Raw bank statements — keyword classify, AI-suggest the rest.
  const expenses: ExpenseToCategorize[] = [];
  for (const aoa of Object.values(sheets)) {
    try { for (const e of parseBankStatement(aoa)) expenses.push({ narration: e.narration, amount: e.amount }); } catch { /* not a statement sheet */ }
  }
  if (expenses.length === 0) {
    return NextResponse.json({ error: "Could not read this file as a bank statement or RCM pivot." }, { status: 400 });
  }

  const confident: { vendor: string; amount: number }[] = [];
  const unmatched: ExpenseToCategorize[] = [];
  for (const e of expenses) {
    const { category } = classifyVendor(e.narration);
    if (category === "foreign" || category === "rent") confident.push({ vendor: e.narration, amount: e.amount });
    else if (category === "review") unmatched.push(e);
  }
  const rc = computeRcm(confident);

  const ai = await categorizeExpensesLLM(unmatched.slice(0, AI_CAP));
  const review = ai
    .filter((a) => a.category === "foreign" || a.category === "rent")
    .map((a) => ({ vendor: a.vendor, amount: a.amount, category: a.category, reason: a.reason }));

  return NextResponse.json({
    source: "bank+ai",
    foreign: { taxable: rc.foreign.taxable, igst: rc.foreign.igst },
    rent: { taxable: rc.rent.taxable, cgst: rc.rent.cgst, sgst: rc.rent.sgst },
    review,
    excluded: [],
    note: `Keyword-matched ${confident.length} RCM rows. AI reviewed ${Math.min(unmatched.length, AI_CAP)} unmatched${unmatched.length > AI_CAP ? ` of ${unmatched.length}` : ""} → ${review.length} suggestion(s). Confirm before filing.`,
  });
}
