import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { reviewQueue, acceptedList } from "@/lib/invoice-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The invoice inbox: the needs_review queue (front-and-centre) + the accepted list. */
export async function GET() {
  if (!(await getSessionEmail())) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const [needsReview, accepted] = await Promise.all([reviewQueue(), acceptedList()]);
    return NextResponse.json({ needsReview, accepted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
