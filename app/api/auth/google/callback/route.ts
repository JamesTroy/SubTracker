import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

// Step 2 of OAuth: exchange the auth code for tokens and persist the account.
// NOTE: to stop refresh tokens expiring every 7 days, set the Google OAuth
// consent screen's publishing status to "In production" (you can stay
// unverified for personal use and click through the warning once).
//
// Every failure path returns a visible error (and logs it) — never a false
// "/?connected=1" success — so a broken connect is diagnosable, not silent.
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
    const body = await tokenRes.text();
    console.error("[oauth] token exchange failed", tokenRes.status, body);
    return NextResponse.json({ step: "token_exchange", error: body }, { status: 502 });
  }
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    return NextResponse.json(
      { step: "refresh_token", error: "No refresh token returned. Revoke access at myaccount.google.com/permissions and reconnect." },
      { status: 400 },
    );
  }

  // Identify the mailbox the token belongs to.
  const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok || !profile.emailAddress) {
    console.error("[oauth] profile fetch failed", profileRes.status, profile);
    return NextResponse.json(
      { step: "profile", status: profileRes.status, error: "Could not read the Gmail address for this account.", detail: profile },
      { status: 502 },
    );
  }

  const { ciphertext, iv, tag } = encrypt(tokens.refresh_token);
  const { error } = await supabaseAdmin().from("gmail_accounts").upsert(
    { email: profile.emailAddress, enc_refresh_token: ciphertext, enc_iv: iv, enc_tag: tag },
    { onConflict: "email" },
  );
  if (error) {
    console.error("[oauth] gmail_accounts upsert failed", error);
    return NextResponse.json({ step: "persist", error: error.message }, { status: 500 });
  }

  console.log("[oauth] connected", profile.emailAddress);
  return NextResponse.redirect(`${process.env.APP_URL}/?connected=1`);
}
