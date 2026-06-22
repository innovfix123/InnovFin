import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth";

/**
 * Login gate. Everything except `/login` (and the login/logout APIs, excluded by the matcher)
 * requires a valid session cookie. Unauthenticated page requests are redirected to `/login`;
 * unauthenticated API requests get a 401. (`proxy` is the Next 16 successor to `middleware`.)
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const email = verifyToken(request.cookies.get(SESSION_COOKIE)?.value);

  // `/login` is the only public page; bounce already-signed-in users to the dashboard.
  if (pathname === "/login") {
    return email ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  if (!email) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except Next internals and the login/logout APIs (which must stay public).
  matcher: ["/((?!api/login|api/logout|_next/static|_next/image|favicon.ico).*)"],
};
