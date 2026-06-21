import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

// Step 2 of OAuth: exchange the auth code for tokens and persist the account.
// NOTE: to stop refresh tokens expiring every 7 days, set the Google OAuth
// consent screen's publishing status to "In production" (you can stay
// unverified for personal use and click through the warning once).
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ error: "missing code" }, { status: 400 });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${process.env.APP_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return NextResponse.json({ error: await tokenRes.text() }, { status: 502 });
  }
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    return NextResponse.json(
      { error: "No refresh token returned. Revoke access at myaccount.google.com and reconnect." },
      { status: 400 },
    );
  }

  // Identify the mailbox the token belongs to.
  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then((r) => r.json());

  const { ciphertext, iv, tag } = encrypt(tokens.refresh_token);
  await supabaseAdmin().from("gmail_accounts").upsert(
    { email: profile.emailAddress, enc_refresh_token: ciphertext, enc_iv: iv, enc_tag: tag },
    { onConflict: "email" },
  );

  return NextResponse.redirect(`${process.env.APP_URL}/?connected=1`);
}
