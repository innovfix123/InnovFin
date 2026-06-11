import { NextResponse } from "next/server";
import { computeGstr3b } from "@/gst-core/gstr3b";
import { gstr3bInputSchema } from "@/lib/gstr3b-input";

export const runtime = "nodejs";

/** Compute the full GSTR-3B (Tables 3.1/4/6.1, Rule 88A offset, cash challan) from validated inputs. */
export async function POST(req: Request) {
  const parsed = gstr3bInputSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  return NextResponse.json(computeGstr3b(parsed.data));
}
