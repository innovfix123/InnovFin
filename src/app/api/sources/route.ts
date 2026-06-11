import { NextResponse } from "next/server";
import { getSalesPlan } from "@/lib/connectors";

export const runtime = "nodejs";

/** Step-1 plan: each app, its auto/manual source, and whether creds are configured. */
export async function GET() {
  return NextResponse.json({ sources: getSalesPlan() });
}
