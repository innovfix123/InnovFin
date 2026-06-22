import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";

export const runtime = "nodejs";

/** Returns the signed-in user's email (for client headers). Protected by the proxy. */
export async function GET() {
  return NextResponse.json({ email: await getSessionEmail() });
}
