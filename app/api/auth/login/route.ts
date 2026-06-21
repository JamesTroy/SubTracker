import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/auth/login { password } — set the session cookie if the shared password
// matches. Public (middleware lets /api/auth/* through) so you can authenticate.
export async function POST(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.json({ error: "login disabled — APP_PASSWORD is not set" }, { status: 400 });

  let body: { password?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  if (typeof body.password !== "string" || body.password !== pw) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await sessionToken(pw), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
