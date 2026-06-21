import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionToken, timingSafeEqualHex } from "@/lib/auth";

// One shared-password gate in front of the dashboard and every data route, so a
// public deployment can't leak the ledger (GET /api/export, /, /sub/[id]) or be
// scanned/mutated by anyone. Closes all of them at once — gating a single route
// while the dashboard still renders the ledger would leave the leak open.
//
// Left PUBLIC: /login + /api/auth/* (you must reach these to authenticate / connect
// Gmail), /api/cron/* (guarded by CRON_SECRET), /preview (mock data), static assets.
// When APP_PASSWORD is unset the gate is skipped entirely (local dev convenience) —
// it MUST be set in production.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/cron/", "/preview"];

export async function middleware(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const expected = await sessionToken(pw);
  if (cookie && timingSafeEqualHex(cookie, expected)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static files; PUBLIC_PREFIXES above
// handles the in-app exceptions.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt)$).*)"],
};
