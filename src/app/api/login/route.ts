import { NextResponse } from "next/server";
import { z } from "zod";
import { checkPassword, isAllowedEmail } from "@/lib/auth";
import { setSession } from "@/lib/session";

export const runtime = "nodejs";

const Body = z.object({ email: z.string(), password: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  // Evaluate both checks, then return one generic message (don't reveal which was wrong).
  const ok = isAllowedEmail(email) && checkPassword(parsed.data.password);
  if (!ok) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  await setSession(email);
  return NextResponse.json({ ok: true, email });
}
