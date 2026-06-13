import { NextResponse } from "next/server";
import { computeGstr3b } from "@/gst-core/gstr3b";
import { reconcileGstr1Vs3b, reconcileGstr3bInternal } from "@/gst-core/reconcile";
import { gstr3bInputSchema, resolveRcm } from "@/lib/gstr3b-input";

export const runtime = "nodejs";

/**
 * Compute the full GSTR-3B (Tables 3.1/4/6.1, Rule 88A offset, cash challan) from validated inputs.
 * If a raw `rcmExpenses` list is supplied, the RCM classifier derives Table 3.1(d) from it
 * (and the classification — including the "review" queue of unknown vendors — is returned).
 * Always returns the forward (GSTR-1 ↔ 3B) and backward (internal invariants) reconciliations.
 */
export async function POST(req: Request) {
  const parsed = gstr3bInputSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }

  const { input, rcmReport } = resolveRcm(parsed.data);
  const result = computeGstr3b(input);

  const reconciliation = {
    gstr1Vs3b: reconcileGstr1Vs3b(input.outward, result),
    internal: reconcileGstr3bInternal(result),
  };

  return NextResponse.json({ ...result, reconciliation, ...(rcmReport ? { rcmReport } : {}) });
}
