#!/usr/bin/env bash
# Recreates the subtracker project. Usage:
#   bash setup.sh           -> writes into ./subtracker
#   bash setup.sh .         -> writes into the current folder
#   bash setup.sh myapp     -> writes into ./myapp
set -e
ROOT="${1:-subtracker}"
echo "Scaffolding into $ROOT ..."

mkdir -p "$ROOT"
cat > "$ROOT/.env.example" << '__MBDEV_EOF__'
# --- App ---
APP_URL=http://localhost:3000

# --- Google OAuth (Gmail API) ---
# Google Cloud Console → APIs & Services → Credentials → OAuth client (Web application).
# Authorized redirect URI: ${APP_URL}/api/auth/google/callback
# IMPORTANT: set the OAuth consent screen publishing status to "In production"
# (you can remain unverified for personal use) or refresh tokens die every 7 days.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# --- Token encryption ---
# 32-byte key, base64. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENC_KEY=

# --- Supabase ---
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# --- Anthropic ---
ANTHROPIC_API_KEY=
# Optional: cheaper extraction on high inbox volumes
# EXTRACTION_MODEL=claude-haiku-4-5-20251001
__MBDEV_EOF__

mkdir -p "$ROOT"
cat > "$ROOT/README.md" << '__MBDEV_EOF__'
# Ledger — a personal subscription tracker

Connects to your Gmail, reads your purchase emails, and tells you what you
**actually** pay every month — without inventing subscriptions that aren't there.

The hard part isn't the plumbing; it's not being wrong. This was built against a
real inbox where the noise (40 Uber Eats orders, BNPL confirmations, retail
shipping pings) outnumbered the real subscriptions 5:1. So the design rule is:

> **A single email is a hypothesis, not a subscription.** Nothing reaches the
> ledger without an explicit recurring marker or repeat charges at a stable
> amount. When the guards can't be sure, it asks — it never guesses.

## How it works

```
Gmail (category:purchases + lifecycle terms)
   → fetch + MIME-decode each new email           lib/gmail.ts
   → Claude extracts structured fields per email  lib/extract.ts
   → five guard layers classify the result        lib/guards.ts
   → ledger persisted to Postgres                 app/api/scan/route.ts
```

### The five guards (`lib/guards.ts`)

1. **Schema** — a malformed LLM extraction is rejected by Zod before it's trusted.
2. **Processor unwrap** — `stripe.com`/`paddle.com` senders are unwrapped to the
   real merchant from the body; BNPL rails (Sezzle, Zip) are excluded as sources.
3. **Grounding + decoy filter** — a claimed amount must appear in its cited quote;
   among multiple amounts, the charge is chosen over savings/credit/threshold decoys.
4. **Corroboration** — group by normalized service; confirm via an explicit
   recurring marker *or* ≥2 charges at a stable amount on a regular cadence. The
   amount-variance test (coefficient of variation) is what rejects the Uber Eats
   stream — same sender, but amounts $24–$121 firing multiple times a day.
5. **Status + confidence** — cancelled → excluded from the total; payment-failed →
   past-due with the amount carried, never invented; low-confidence → review queue.

Resolved review items are remembered as durable `service_overrides`, so the same
ambiguous pattern auto-resolves on every future scan.

Run the guard suite against representative real-email fixtures:

```bash
npm run verify:guards
```

## Setup

### 1. Supabase
Create a project, then run the migration in `supabase/migrations/0001_init.sql`
(SQL editor, or `supabase db push`). Copy the project URL and the **service-role**
key into `.env`.

### 2. Google Cloud (Gmail API)
- Enable the **Gmail API**.
- Create an **OAuth client** of type *Web application*. Add redirect URI
  `http://localhost:3000/api/auth/google/callback`.
- Add only the `gmail.readonly` scope.
- **Set the OAuth consent screen publishing status to "In production."** You can
  stay unverified for personal use (you'll click through one warning) — this is
  what stops refresh tokens from expiring every 7 days, which they do in "Testing."

### 3. Env
```bash
cp .env.example .env   # fill in every value
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # TOKEN_ENC_KEY
```

### 4. Run
```bash
npm install
npm run dev
```
Open `http://localhost:3000`, click **Connect Gmail**, then **Scan inbox**.

> Versions in `package.json` are indicative — if the Anthropic SDK or Supabase
> client has moved, `npm install @anthropic-ai/sdk@latest @supabase/supabase-js@latest`.

## File map

```
supabase/migrations/0001_init.sql   schema (cents, evidence split, overrides)
lib/
  gmail.ts        OAuth refresh, search, MIME decode (read-only)
  extract.ts      the tuned Claude prompt + forced tool-call
  guards.ts       the five-layer pipeline (pure, testable)
  crypto.ts       AES-256-GCM for the refresh token at rest
  supabase.ts     server client (service role)
  types.ts        shared types
app/
  page.tsx        the ledger dashboard
  actions.tsx     scan + review client actions
  api/auth/google/…  OAuth start + callback
  api/scan/route.ts  the orchestrator
  api/review/route.ts review resolution + learning loop
scripts/verify-guards.ts  proves the guards on real fixtures
```

## Known next steps
- **PDF amounts.** Stripe receipt bodies carry the amount, but a few processors
  send a body-less email with the price only in the attached PDF (`hasPdf` is
  already surfaced by `getMessage`). Add an attachment-fetch + PDF text extract
  as a fallback for `amount === null` confirmed subs (they show "needs PDF").
- **Scheduled scans.** Wire `POST /api/scan` to a Vercel/Supabase cron.
- **Multi-account / RLS.** Schema is keyed for it; enable RLS and scope by user_id
  if this ever leaves single-user.
__MBDEV_EOF__

mkdir -p "$ROOT/app"
cat > "$ROOT/app/actions.tsx" << '__MBDEV_EOF__'
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function scan() {
    setBusy(true);
    try {
      await fetch("/api/scan", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="scan" onClick={scan} disabled={busy}>
      {busy ? "scanning…" : "Scan inbox"}
    </button>
  );
}

export function ReviewActions({ id }: { id: string }) {
  const [done, setDone] = useState<string | null>(null);
  const router = useRouter();
  async function resolve(decision: "confirmed" | "rejected") {
    setDone(decision);
    await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    router.refresh();
  }
  if (done) return <span className="why">{done === "confirmed" ? "kept" : "dismissed"}</span>;
  return (
    <div className="actions">
      <button className="act keep" onClick={() => resolve("confirmed")}>It’s a subscription</button>
      <button className="act" onClick={() => resolve("rejected")}>Not one</button>
    </div>
  );
}
__MBDEV_EOF__

mkdir -p "$ROOT/app/api/auth/google/callback"
cat > "$ROOT/app/api/auth/google/callback/route.ts" << '__MBDEV_EOF__'
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
__MBDEV_EOF__

mkdir -p "$ROOT/app/api/auth/google"
cat > "$ROOT/app/api/auth/google/route.ts" << '__MBDEV_EOF__'
import { NextResponse } from "next/server";

// Step 1 of OAuth: send the user to Google's consent screen.
// access_type=offline + prompt=consent guarantees a refresh token is returned.
export async function GET() {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${process.env.APP_URL}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return NextResponse.redirect(url.toString());
}
__MBDEV_EOF__

mkdir -p "$ROOT/app/api/review"
cat > "$ROOT/app/api/review/route.ts" << '__MBDEV_EOF__'
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// POST /api/review  { id, decision: 'confirmed' | 'rejected' }
// Resolves a review item AND records a durable service_override so the same
// pattern auto-resolves on every future scan — the learning loop.
export async function POST(req: NextRequest) {
  const { id, decision } = await req.json();
  if (!["confirmed", "rejected"].includes(decision)) {
    return NextResponse.json({ error: "decision must be confirmed or rejected" }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { data: item } = await db.from("review_items").select("*").eq("id", id).single();
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.from("review_items").update({
    status: decision, resolved_service_key: item.service_key, resolved_at: new Date().toISOString(),
  }).eq("id", id);

  if (item.service_key) {
    await db.from("service_overrides").upsert({
      service_key: item.service_key,
      decision: decision === "confirmed" ? "subscription" : "not_subscription",
    }, { onConflict: "service_key" });
  }

  return NextResponse.json({ ok: true });
}
__MBDEV_EOF__

mkdir -p "$ROOT/app/api/scan"
cat > "$ROOT/app/api/scan/route.ts" << '__MBDEV_EOF__'
import { NextResponse } from "next/server";
import { decrypt } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { getAccessToken, searchMessageIds, getMessage, CANDIDATE_QUERY } from "@/lib/gmail";
import { extractFromEmail } from "@/lib/extract";
import { runPipeline } from "@/lib/guards";
import { PipelineInput, SubResult } from "@/lib/types";

const dollarsToCents = (d: number | null) => (d === null ? null : Math.round(d * 100));

// POST /api/scan — full pipeline: Gmail → extract → guards → persist.
// Idempotent: messages already in charge_evidence are skipped.
export async function POST() {
  const db = supabaseAdmin();

  const { data: account } = await db.from("gmail_accounts").select("*").limit(1).single();
  if (!account) return NextResponse.json({ error: "No Gmail account connected" }, { status: 400 });

  const run = await db.from("scan_runs").insert({ account_id: account.id }).select().single();
  const runId = run.data!.id;

  try {
    const accessToken = await getAccessToken(
      decrypt(account.enc_refresh_token, account.enc_iv, account.enc_tag),
    );

    // Find candidates, skip ones we've already processed.
    const allIds = await searchMessageIds(accessToken, CANDIDATE_QUERY);
    const { data: seen } = await db
      .from("charge_evidence").select("gmail_message_id").in("gmail_message_id", allIds);
    const seenSet = new Set((seen ?? []).map((r) => r.gmail_message_id));
    const newIds = allIds.filter((id) => !seenSet.has(id));

    // Fetch + extract each new email (bounded concurrency keeps API load sane).
    const inputs: PipelineInput[] = [];
    for (const batch of chunk(newIds, 5)) {
      const settled = await Promise.all(
        batch.map(async (id) => {
          const email = await getMessage(accessToken, id);
          const extraction = await extractFromEmail(email);
          return { email, extraction };
        }),
      );
      inputs.push(...settled);
    }

    // Load durable user decisions, then run the guard stack.
    const { data: ov } = await db.from("service_overrides").select("*");
    const overrides = new Map<string, "subscription" | "not_subscription">(
      (ov ?? []).map((o) => [o.service_key, o.decision]),
    );
    const ledger = runPipeline(inputs, overrides);

    // --- Persist -----------------------------------------------------------
    // 1) Upsert subscriptions (active + past_due + ending + candidates).
    const allSubs: SubResult[] = [
      ...ledger.active, ...ledger.pastDue, ...ledger.ending, ...ledger.candidates,
    ];
    const subRows = allSubs.map((s) => ({
      service_key: s.serviceKey, service_name: s.serviceName, service_domain: s.serviceDomain,
      amount_cents: dollarsToCents(s.amount), currency: s.currency, billing_cycle: s.billingCycle,
      status: s.status, next_renewal: s.nextRenewal, confidence: s.confidence,
      evidence_count: s.evidenceCount, last_seen: new Date().toISOString(), updated_at: new Date().toISOString(),
    }));
    if (subRows.length) await db.from("subscriptions").upsert(subRows, { onConflict: "service_key" });

    // 2) Insert evidence rows (idempotent on gmail_message_id), linked to subs.
    const subIdByKey = new Map<string, string>();
    if (allSubs.length) {
      const { data: stored } = await db
        .from("subscriptions").select("id, service_key")
        .in("service_key", allSubs.map((s) => s.serviceKey));
      for (const r of stored ?? []) subIdByKey.set(r.service_key, r.id);
    }
    const evRows = ledger.evidence.map((e) => ({
      gmail_message_id: e.messageId, subscription_id: subIdByKey.get(e.serviceKey) ?? null,
      service_key: e.serviceKey, from_name: e.fromName, from_domain: e.fromDomain, subject: e.subject,
      received_at: e.receivedAt, amount_cents: dollarsToCents(e.amount), currency: e.currency,
      event_type: e.eventType, amount_quote: e.quote, raw_confidence: e.confidence,
    }));
    if (evRows.length) await db.from("charge_evidence").upsert(evRows, { onConflict: "gmail_message_id" });

    // 3) Queue review items.
    const reviewRows = ledger.review.map((r) => ({
      gmail_message_id: r.messageId, service_key: r.serviceKey, reason: r.reason, raw: r.raw as object,
    }));
    if (reviewRows.length) await db.from("review_items").upsert(reviewRows, { onConflict: "gmail_message_id" });

    await db.from("scan_runs").update({
      finished_at: new Date().toISOString(), emails_scanned: allIds.length, emails_new: newIds.length,
      n_active: ledger.active.length, n_past_due: ledger.pastDue.length, n_ending: ledger.ending.length,
      n_review: ledger.review.length, n_rejected: ledger.rejected.length,
    }).eq("id", runId);
    await db.from("gmail_accounts").update({ last_scan_at: new Date().toISOString() }).eq("id", account.id);

    return NextResponse.json({
      scanned: allIds.length, new: newIds.length,
      active: ledger.active.length, pastDue: ledger.pastDue.length, ending: ledger.ending.length,
      review: ledger.review.length, rejected: ledger.rejected.length,
      monthlyTotal: ledger.monthlyTotal, trace: ledger.trace,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("scan_runs").update({ finished_at: new Date().toISOString(), error: msg }).eq("id", runId);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
__MBDEV_EOF__

mkdir -p "$ROOT/app"
cat > "$ROOT/app/globals.css" << '__MBDEV_EOF__'
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500&display=swap');

:root {
  --bg: #0c0c0e;
  --panel: #131316;
  --line: #24242a;
  --ink: #e8e4da;       /* warm paper */
  --ink-dim: #8a867d;
  --ink-faint: #56534c;
  --amber: #c5a572;     /* tungsten — active */
  --rust: #b4624a;      /* past due */
  --serif: 'Fraunces', Georgia, serif;
  --mono: 'IBM Plex Mono', ui-monospace, monospace;
  --body: 'Inter', system-ui, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  -webkit-font-smoothing: antialiased;
  line-height: 1.5;
}

.wrap { max-width: 760px; margin: 0 auto; padding: 64px 24px 120px; }

/* Masthead */
.eyebrow {
  font-family: var(--mono);
  font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--ink-faint);
}
.masthead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 56px; }
.masthead h1 { font-family: var(--serif); font-weight: 500; font-size: 22px; letter-spacing: -0.01em; }

/* Hero — the total, and what was held back */
.hero { border-top: 1px solid var(--line); padding-top: 40px; margin-bottom: 56px; }
.hero .label { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); letter-spacing: 0.04em; }
.hero .total {
  font-family: var(--serif); font-weight: 400; font-size: 88px; line-height: 0.95;
  letter-spacing: -0.03em; margin: 10px 0 4px; font-feature-settings: 'tnum';
}
.hero .total .cents { color: var(--ink-dim); font-size: 52px; }
.hero .sub { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); }
.hero .held {
  margin-top: 22px; font-family: var(--mono); font-size: 12.5px; color: var(--ink-faint);
  border-left: 2px solid var(--amber); padding-left: 12px; line-height: 1.7;
}
.hero .held b { color: var(--amber); font-weight: 500; }

/* Sections */
.section { margin-bottom: 44px; }
.section > h2 {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--ink-dim); margin-bottom: 14px; display: flex; justify-content: space-between;
}
.section > h2 .count { color: var(--ink-faint); }

/* Ledger rows */
.row {
  display: grid; grid-template-columns: 1fr auto; align-items: baseline;
  padding: 13px 0; border-bottom: 1px solid var(--line); gap: 16px;
}
.row .name { font-size: 15px; letter-spacing: -0.005em; }
.row .meta { font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint); margin-top: 2px; }
.row .amt { font-family: var(--mono); font-size: 15px; font-weight: 500; font-feature-settings: 'tnum'; white-space: nowrap; }
.row .amt.dim { color: var(--ink-faint); font-weight: 400; }
.tag {
  display: inline-block; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em;
  padding: 1px 6px; border-radius: 2px; margin-left: 8px; vertical-align: middle;
}
.tag.due { color: var(--rust); border: 1px solid color-mix(in srgb, var(--rust) 45%, transparent); }
.tag.end { color: var(--ink-faint); border: 1px solid var(--line); }

/* Review queue */
.review .row { grid-template-columns: 1fr auto; }
.review .why { font-family: var(--mono); font-size: 11.5px; color: var(--ink-dim); margin-top: 3px; }
.actions { display: flex; gap: 8px; }
button.act {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em;
  background: transparent; color: var(--ink-dim); border: 1px solid var(--line);
  padding: 5px 11px; border-radius: 3px; cursor: pointer; transition: all .12s;
}
button.act:hover { border-color: var(--ink-dim); color: var(--ink); }
button.act.keep:hover { border-color: var(--amber); color: var(--amber); }
button.act:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

/* Scan control + footer */
.scanbar { display: flex; align-items: center; gap: 14px; }
button.scan {
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.04em;
  background: var(--amber); color: #1a1408; border: none;
  padding: 8px 16px; border-radius: 4px; cursor: pointer;
}
button.scan:disabled { opacity: .5; cursor: default; }
.scanbar .when { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); }

.empty {
  font-family: var(--mono); font-size: 12.5px; color: var(--ink-faint);
  border: 1px dashed var(--line); border-radius: 4px; padding: 16px; text-align: center;
}
.kept-foot { font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint); line-height: 1.9; }
.kept-foot .k { color: var(--ink-dim); }

@media (max-width: 560px) {
  .hero .total { font-size: 64px; }
  .hero .total .cents { font-size: 38px; }
  .masthead { flex-direction: column; gap: 6px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
__MBDEV_EOF__

mkdir -p "$ROOT/app"
cat > "$ROOT/app/layout.tsx" << '__MBDEV_EOF__'
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ledger — subscription tracker",
  description: "What you actually pay every month.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
__MBDEV_EOF__

mkdir -p "$ROOT/app"
cat > "$ROOT/app/page.tsx" << '__MBDEV_EOF__'
import { supabaseAdmin } from "@/lib/supabase";
import { ScanButton, ReviewActions } from "./actions";

export const dynamic = "force-dynamic";

const money = (cents: number | null) =>
  cents === null ? null : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3.6e6);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

type Sub = {
  id: string; service_name: string; service_domain: string | null; amount_cents: number | null;
  billing_cycle: string; status: string; next_renewal: string | null; evidence_count: number;
};

export default async function Page() {
  const db = supabaseAdmin();
  const [{ data: subs }, { data: review }, { data: scan }, { data: account }] = await Promise.all([
    db.from("subscriptions").select("*").order("amount_cents", { ascending: false, nullsFirst: false }),
    db.from("review_items").select("*").eq("status", "pending").order("created_at"),
    db.from("scan_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("gmail_accounts").select("email,last_scan_at").maybeSingle(),
  ]);

  const all = (subs ?? []) as Sub[];
  const active = all.filter((s) => s.status === "active");
  const pastDue = all.filter((s) => s.status === "past_due");
  const ending = all.filter((s) => s.status === "ending");

  const totalCents = active.reduce((t, s) => t + (s.amount_cents ?? 0), 0);
  const [dollars, cents] = money(totalCents)!.split(".");
  const priced = active.filter((s) => s.amount_cents !== null).length;
  const heldBack = scan?.n_rejected ?? 0;

  return (
    <main className="wrap">
      <div className="masthead">
        <div>
          <div className="eyebrow">build quiet · ship loud</div>
          <h1>Ledger</h1>
        </div>
        <div className="scanbar">
          <span className="when">{account?.email ? `synced ${ago(account.last_scan_at)}` : "not connected"}</span>
          {account?.email ? <ScanButton /> : <a className="scan" href="/api/auth/google">Connect Gmail</a>}
        </div>
      </div>

      <section className="hero">
        <div className="label">monthly, confirmed</div>
        <div className="total">
          ${dollars}<span className="cents">.{cents}</span>
        </div>
        <div className="sub">{priced} priced · {active.length} active subscriptions</div>
        {heldBack > 0 && (
          <div className="held">
            <b>{heldBack} emails held back</b> this scan — one-time orders, payment rails, and
            status notifications that look transactional but aren’t recurring.
          </div>
        )}
      </section>

      <Section title="Active" count={active.length}>
        {active.length === 0
          ? <Empty connected={!!account?.email} />
          : active.map((s) => <Row key={s.id} s={s} />)}
      </Section>

      {pastDue.length > 0 && (
        <Section title="Past due" count={pastDue.length}>
          {pastDue.map((s) => <Row key={s.id} s={s} tag="due" />)}
        </Section>
      )}

      {ending.length > 0 && (
        <Section title="Ending" count={ending.length}>
          {ending.map((s) => <Row key={s.id} s={s} tag="end" />)}
        </Section>
      )}

      {(review ?? []).length > 0 && (
        <section className="section review">
          <h2>Needs a decision <span className="count">{review!.length}</span></h2>
          {review!.map((r) => (
            <div className="row" key={r.id}>
              <div>
                <div className="name">{r.service_key ?? "Unknown charge"}</div>
                <div className="why">{r.reason}</div>
              </div>
              <ReviewActions id={r.id} />
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <h2>The rule</h2>
        <div className="kept-foot">
          <span className="k">A single email is a hypothesis, not a subscription.</span> Nothing reaches
          this ledger without an explicit recurring marker or repeat charges at a stable amount. When the
          guards can’t be sure, it asks — it never guesses.
        </div>
      </section>
    </main>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title} <span className="count">{count}</span></h2>
      {children}
    </section>
  );
}

function Row({ s, tag }: { s: Sub; tag?: "due" | "end" }) {
  const amt = money(s.amount_cents);
  return (
    <div className="row">
      <div>
        <div className="name">
          {s.service_name}
          {tag === "due" && <span className="tag due">payment failed</span>}
          {tag === "end" && <span className="tag end">won’t renew</span>}
        </div>
        <div className="meta">
          {s.billing_cycle}
          {s.evidence_count > 1 ? ` · ${s.evidence_count} receipts` : ""}
          {s.next_renewal ? ` · renews ${s.next_renewal}` : ""}
        </div>
      </div>
      <div className={`amt${amt === null ? " dim" : ""}`}>
        {amt === null ? "needs PDF" : `$${amt}`}
      </div>
    </div>
  );
}

function Empty({ connected }: { connected: boolean }) {
  return (
    <div className="empty">
      {connected
        ? "No confirmed subscriptions yet — run a scan to read your inbox."
        : "Connect Gmail to find your subscriptions."}
    </div>
  );
}
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/crypto.ts" << '__MBDEV_EOF__'
import crypto from "node:crypto";

// AES-256-GCM encryption for the Gmail refresh token.
// TOKEN_ENC_KEY must be a 32-byte key, base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

function key(): Buffer {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is not set");
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENC_KEY must decode to 32 bytes");
  return buf;
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(ciphertext: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/extract.ts" << '__MBDEV_EOF__'
import Anthropic from "@anthropic-ai/sdk";
import { EmailMeta, Extraction } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sonnet by default for accuracy; set EXTRACTION_MODEL=claude-haiku-4-5-20251001
// to cut cost on high inbox volumes.
const MODEL = process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6";

// The rules below were derived directly from a real inbox. Each line maps to a
// concrete failure mode we observed (decoys, processor senders, dunning with no
// price, one-time food orders, etc.). Conservatism is the whole point: a phantom
// subscription erodes trust faster than a missed one.
const SYSTEM = `You extract subscription information from a single email. Return ONLY a call to the "record_extraction" tool. Follow these rules exactly.

GROUNDING
- Set "amount" only if an explicit price appears in THIS email. Copy the price into "value" and copy the surrounding literal sentence into "quote". Never compute, infer, or estimate a price. If no price is present, set amount to null.
- Many emails contain several dollar figures. Choose the one that represents what the customer is charged (look for "charged", "Plan Price", "Total", "Amount paid", "Amount due"). Never pick figures next to "saved", "savings", "credit", "value", "off", "orders over", or "free delivery" — those are marketing, not the charge.

THE SERVICE, NOT THE PROCESSOR
- The sender domain is often a payment processor (stripe.com, paddle.com), not the service. Read the real merchant from the display name or body (e.g. "Receipt from Rork, Inc." → serviceName "Rork"). Put that in serviceName, and the merchant's own domain (e.g. from a support email) in serviceDomain. For these, isPaymentProcessor is FALSE — the merchant is a real subscription.
- Buy-now-pay-later confirmations (Sezzle, Zip, Affirm, Klarna) are a payment rail, not a subscription. When the email is only a BNPL payment confirmation, set isPaymentProcessor TRUE and isSubscription FALSE.

EVENT TYPE (subscriptions are mostly lifecycle emails, often with no price)
- "charged": a completed charge / renewal receipt.
- "upcoming": an announced future charge ("renewing soon", "will be charged").
- "payment_failed": dunning ("payment failed", "update your payment method", "we'll retry"). Usually no amount — leave amount null.
- "cancelled": will not renew / has been canceled / ending.
- "started": welcome / activation of a plan.
- "none": not a charge or subscription event (shipping update, order status, one-time purchase).

RECURRING MARKER
- hasRecurringMarker is true only when the email explicitly signals recurrence: the words subscription / membership / auto-renew / "renews" / a billing period range like "Jun 20 – Jul 20" / "Powered by Stripe Billing". A one-time receipt with none of these is false.

CONSERVATISM
- A single food-delivery or retail receipt (Uber Eats, DoorDash food order, a store purchase) is NOT a subscription: isSubscription false, eventType "charged" or "none", hasRecurringMarker false.
- If you are unsure whether something is a subscription, set isSubscription false and lower the confidence. Confidence is your honest probability (0–1) that this email represents a real recurring subscription.`;

const TOOL: Anthropic.Tool = {
  name: "record_extraction",
  description: "Record the structured subscription extraction for this email.",
  input_schema: {
    type: "object",
    properties: {
      isSubscription: { type: "boolean" },
      isPaymentProcessor: { type: "boolean" },
      serviceName: { type: ["string", "null"] },
      serviceDomain: { type: ["string", "null"] },
      amount: {
        type: ["object", "null"],
        properties: {
          value: { type: "string", description: "the price exactly as written, e.g. $12.99" },
          quote: { type: "string", description: "the literal sentence the price came from" },
        },
        required: ["value", "quote"],
      },
      currency: { type: ["string", "null"] },
      billingCycle: { type: "string", enum: ["weekly", "monthly", "quarterly", "annual", "unknown"] },
      billingPeriod: {
        type: ["object", "null"],
        properties: { start: { type: "string" }, end: { type: "string" } },
        required: ["start", "end"],
      },
      nextRenewal: { type: ["string", "null"], description: "ISO date if stated" },
      eventType: { type: "string", enum: ["charged", "upcoming", "payment_failed", "cancelled", "started", "none"] },
      hasRecurringMarker: { type: "boolean" },
      confidence: { type: "number" },
    },
    required: [
      "isSubscription", "isPaymentProcessor", "serviceName", "serviceDomain",
      "amount", "currency", "billingCycle", "billingPeriod", "nextRenewal",
      "eventType", "hasRecurringMarker", "confidence",
    ],
  },
};

export async function extractFromEmail(email: EmailMeta): Promise<Extraction> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "record_extraction" },
    messages: [
      {
        role: "user",
        content:
          `From: ${email.fromName} <…@${email.fromDomain}>\n` +
          `Subject: ${email.subject}\n` +
          `Date: ${email.date}\n\n` +
          `${email.bodyText}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`No tool_use returned for message ${email.id}`);
  }
  // Returned as `unknown` on purpose — guards.ts validates it with Zod before
  // anything trusts it. A malformed shape is caught there, not here.
  return block.input as Extraction;
}
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/gmail.ts" << '__MBDEV_EOF__'
import { EmailMeta } from "./types";

// Minimal Gmail API client. Read-only; never mutates the mailbox.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Exchange a refresh token for a short-lived access token.
export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // invalid_grant here usually means the consent screen is still in "Testing"
    // (7-day token expiry) or the user revoked access — prompt a reconnect.
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }
  return (await res.json()).access_token as string;
}

// List message ids matching a Gmail search query, paging up to `cap`.
export async function searchMessageIds(
  accessToken: string,
  query: string,
  cap = 500,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`messages.list failed (${res.status})`);
    const data = await res.json();
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < cap);
  return ids.slice(0, cap);
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
  filename?: string;
}

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Walk the MIME tree, preferring text/plain, falling back to stripped text/html.
function extractBody(payload: GmailPart): { text: string; hasPdf: boolean } {
  let plain = "";
  let html = "";
  let hasPdf = false;
  const walk = (p: GmailPart) => {
    if (p.filename && /\.pdf$/i.test(p.filename)) hasPdf = true;
    if (p.mimeType === "text/plain" && p.body?.data) plain += b64urlDecode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) html += b64urlDecode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const text = plain.trim()
    ? plain
    : html.replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;|&zwnj;|\u034f/g, " ")
          .replace(/\s+/g, " ");
  return { text: text.trim(), hasPdf };
}

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(raw: string): { name: string; domain: string } {
  const m = raw.match(/^(.*?)<([^>]+)>$/);
  const name = (m ? m[1] : raw).replace(/"/g, "").trim();
  const email = (m ? m[2] : raw).trim();
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return { name: name || email, domain };
}

// Fetch one message and flatten it into EmailMeta (+ a hasPdf hint for the
// rare body-less Paddle receipts where the amount lives only in the PDF).
export async function getMessage(
  accessToken: string,
  id: string,
): Promise<EmailMeta & { hasPdf: boolean }> {
  const res = await fetch(`${API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`messages.get failed (${res.status}) for ${id}`);
  const msg = await res.json();
  const headers = msg.payload?.headers ?? [];
  const { name, domain } = parseFrom(header(headers, "From"));
  const { text, hasPdf } = extractBody(msg.payload ?? {});
  return {
    id,
    fromName: name,
    fromDomain: domain,
    subject: header(headers, "Subject"),
    date: new Date(Number(msg.internalDate)).toISOString(),
    bodyText: text.slice(0, 6000), // cap tokens sent to the extractor
    hasPdf,
  };
}

// The candidate net. category:purchases is the strongest single filter; the OR
// terms catch lifecycle emails (dunning, cancellations) Gmail files elsewhere.
export const CANDIDATE_QUERY =
  'newer_than:1y (category:purchases OR subscription OR renew OR membership OR "payment failed" OR "auto-renew")';
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/guards.ts" << '__MBDEV_EOF__'
import { z } from "zod";
import {
  EmailMeta, EmailTrace, GuardEvent, LedgerResult, PipelineInput,
  SubResult, EventType, BillingCycle,
} from "./types";

// ---------------------------------------------------------------------------
// L1: schema — a malformed extraction is rejected here before it is trusted.
// ---------------------------------------------------------------------------
const EvidenceSchema = z.object({ value: z.string(), quote: z.string() }).nullable();
export const ExtractionSchema = z.object({
  isSubscription: z.boolean(),
  isPaymentProcessor: z.boolean(),
  serviceName: z.string().nullable(),
  serviceDomain: z.string().nullable(),
  amount: EvidenceSchema,
  currency: z.string().nullable(),
  billingCycle: z.enum(["weekly", "monthly", "quarterly", "annual", "unknown"]),
  billingPeriod: z.object({ start: z.string(), end: z.string() }).nullable(),
  nextRenewal: z.string().nullable(),
  eventType: z.enum(["charged", "upcoming", "payment_failed", "cancelled", "started", "none"]),
  hasRecurringMarker: z.boolean(),
  confidence: z.number().min(0).max(1),
});
type Extraction = z.infer<typeof ExtractionSchema>;

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------
const MONEY = /(?:US)?\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
const parseMoney = (s: string): number | null => {
  const m = new RegExp(MONEY).exec(s);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const parseAllMoney = (s: string): number[] => {
  const out: number[] = []; let m; const re = new RegExp(MONEY);
  while ((m = re.exec(s)) !== null) out.push(Number(m[1].replace(/,/g, "")));
  return out;
};

// L2a: grounding — the claimed amount must appear in its cited quote, and the
// quote must be a real substring of the body. Catches fabricated amounts.
function groundAmount(ev: { value: string; quote: string } | null, body: string): number | null {
  if (!ev) return null;
  const claimed = parseMoney(ev.value);
  if (claimed === null) return null;
  if (!body.includes(ev.quote)) return null;
  return parseAllMoney(ev.quote).some((n) => Math.abs(n - claimed) < 0.001) ? claimed : null;
}

// L2b: decoy backstop — among all amounts in a body, prefer the one nearest
// charge language and away from savings/credit/threshold language.
const CHARGE_KW = /charged|plan price|amount paid|amount due|total|billed|price/i;
const EXCLUDE_KW = /saved|savings|credit|value|off|over \$|free delivery|orders over/i;
function selectChargeAmount(body: string): number | null {
  let best: { amount: number; score: number } | null = null; let m; const re = new RegExp(MONEY);
  while ((m = re.exec(body)) !== null) {
    const amt = Number(m[1].replace(/,/g, ""));
    const w = body.slice(Math.max(0, m.index - 45), m.index + 25);
    let score = 0;
    if (CHARGE_KW.test(w)) score += 2;
    if (EXCLUDE_KW.test(w)) score -= 3;
    if (!best || score > best.score) best = { amount: amt, score };
  }
  return best && best.score > 0 ? best.amount : null;
}

// L2c: processor unwrap — sender domain is never the service for these.
const PROCESSORS = new Set(["stripe.com", "paddle.com", "braintreegateway.com"]);
const BNPL = new Set(["sezzle.com", "zip.co", "affirm.com", "klarna.com"]);

// Product-aware service key so DashPass ≠ DoorDash food orders, and the two
// Reddit email formats merge to one subscription.
export function deriveServiceKey(e: EmailMeta, x: Extraction): string {
  const t = (e.subject + " " + e.bodyText).toLowerCase();
  if (/dashpass/.test(t)) return "doordash-dashpass";
  if (/uber eats/.test(t)) return "uber-eats-orders";
  if (/freshpass/.test(t)) return "vons-freshpass";
  if (/reddit premium|reddit, inc/.test(t)) return "reddit-premium";
  const name = x.serviceName ?? e.fromName;
  return name.toLowerCase()
    .replace(/,?\s*(inc|llc|co)\.?$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Streams that are inherently per-order; routed through the variance test and
// rejected wholesale rather than ever treated as recurring.
const TRANSACTIONAL_STREAMS = new Set(["uber-eats-orders", "doordash-orders"]);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const stddev = (a: number[]) => { const mu = mean(a); return Math.sqrt(mean(a.map((x) => (x - mu) ** 2))); };
const gapsDays = (dates: Date[]) => {
  const s = [...dates].sort((a, b) => a.getTime() - b.getTime()); const g: number[] = [];
  for (let i = 1; i < s.length; i++) g.push((s[i].getTime() - s[i - 1].getTime()) / 86_400_000);
  return g;
};
const isMonthlyCadence = (g: number[]) => g.length > 0 && g.every((d) => d >= 24 && d <= 35);

// Tunable thresholds — these are the knobs.
const CV_CEILING = 0.03;        // max amount variation for a confirmed recurring charge
const CONFIDENCE_FLOOR = 0.5;   // below this with no amount → review, not a guess
const CORROBORATION_MIN = 2;    // emails needed to confirm without an explicit marker

interface Charge {
  id: string; service: string; serviceName: string; serviceDomain: string | null;
  amount: number | null; date: Date; marker: boolean; event: EventType;
  cycle: BillingCycle; nextRenewal: string | null; confidence: number;
}

// ===========================================================================
// runPipeline — the whole guard stack as one pure function.
// overrides: durable user decisions from service_overrides (the learning loop).
// ===========================================================================
export function runPipeline(
  inputs: PipelineInput[],
  overrides: Map<string, "subscription" | "not_subscription"> = new Map(),
): LedgerResult {
  const trace: EmailTrace[] = [];
  const charges: Charge[] = [];
  const review: LedgerResult["review"] = [];
  const rejected: LedgerResult["rejected"] = [];
  const evidence: LedgerResult["evidence"] = [];

  for (const { email, extraction } of inputs) {
    const ev: GuardEvent[] = [];
    const push = (tag: string, level: GuardEvent["level"], msg: string) => ev.push({ tag, level, msg });

    // L1 — schema
    const parsed = ExtractionSchema.safeParse(extraction);
    if (!parsed.success) {
      const iss = parsed.error.issues[0];
      push("L1 schema", "fail", `Zod rejected (${iss.path.join(".")}: ${iss.message}) → review`);
      review.push({ messageId: email.id, serviceKey: null, reason: "malformed extraction", raw: extraction });
      trace.push({ emailId: email.id, subject: email.subject, events: ev });
      continue;
    }
    const x = parsed.data;
    const key = deriveServiceKey(email, x);
    push("L1 schema", "pass", `valid (conf ${x.confidence})`);

    // L2c — processor / BNPL
    if (BNPL.has(email.fromDomain) || x.isPaymentProcessor) {
      push("L2 processor", "fail", `BNPL/payment rail (${email.fromDomain}) → excluded as a source`);
      rejected.push({ ref: email.id, reason: `payment rail (${email.fromDomain})` });
      trace.push({ emailId: email.id, subject: email.subject, events: ev });
      continue;
    }
    if (PROCESSORS.has(email.fromDomain)) {
      if (!x.serviceName) {
        push("L2 processor", "fail", `${email.fromDomain} processor, no merchant in body → review`);
        review.push({ messageId: email.id, serviceKey: null, reason: "unresolved processor merchant", raw: x });
        trace.push({ emailId: email.id, subject: email.subject, events: ev });
        continue;
      }
      push("L2 processor", "info", `${email.fromDomain} unwrapped → "${x.serviceName}" (key ${key})`);
    }

    // L1 — pure status / one-time noise (no amount, no recurring signal)
    if (!x.isSubscription && !x.hasRecurringMarker && x.amount === null && x.eventType === "none") {
      push("L1 status", "fail", `no amount + no recurring signal → dropped`);
      rejected.push({ ref: email.id, reason: "one-time or status notification" });
      trace.push({ emailId: email.id, subject: email.subject, events: ev });
      continue;
    }

    // L2a — ground the amount
    let amount = groundAmount(x.amount, email.bodyText);
    if (x.amount && amount === null) push("L2 ground", "fail", `claimed ${x.amount.value} not grounded → nulled`);
    else if (amount !== null) push("L2 ground", "pass", `$${amount} grounded in quote`);

    // L2b — decoy backstop
    const allAmts = parseAllMoney(email.bodyText);
    if (allAmts.length > 1) {
      const pick = selectChargeAmount(email.bodyText);
      if (pick !== null) {
        if (amount !== null && Math.abs(pick - amount) > 0.001) {
          push("L2 decoy", "fail", `${allAmts.length} amounts → charge-context overrides to $${pick}`);
          amount = pick;
        } else {
          push("L2 decoy", "pass", `${allAmts.length} amounts → confirms $${pick}, decoys ignored`);
        }
      }
    }

    // L5 — confidence floor (only when there's nothing to corroborate)
    if (x.confidence < CONFIDENCE_FLOOR && amount === null && x.eventType !== "cancelled") {
      push("L5 conf", "fail", `confidence ${x.confidence} < ${CONFIDENCE_FLOOR}, no amount → review`);
      review.push({ messageId: email.id, serviceKey: key, reason: `low confidence (${x.confidence})`, raw: x });
      trace.push({ emailId: email.id, subject: email.subject, events: ev });
      continue;
    }

    charges.push({
      id: email.id, service: key, serviceName: x.serviceName ?? email.fromName,
      serviceDomain: x.serviceDomain, amount, date: new Date(email.date),
      marker: x.hasRecurringMarker, event: x.eventType, cycle: x.billingCycle,
      nextRenewal: x.nextRenewal, confidence: x.confidence,
    });
    evidence.push({
      messageId: email.id, serviceKey: key, fromName: email.fromName, fromDomain: email.fromDomain,
      subject: email.subject, receivedAt: email.date, amount, currency: x.currency,
      eventType: x.eventType, quote: x.amount?.quote ?? null, confidence: x.confidence,
    });
    push("→ collect", "info", `to corroboration as "${key}" (${x.eventType}, ${amount ?? "—"})`);
    trace.push({ emailId: email.id, subject: email.subject, events: ev });
  }

  // -------------------------------------------------------------------------
  // L3 — corroboration (group-level truth)
  // -------------------------------------------------------------------------
  const groups = new Map<string, Charge[]>();
  for (const c of charges) (groups.get(c.service) ?? groups.set(c.service, []).get(c.service)!).push(c);

  const results: SubResult[] = [];
  const corrobTrace: GuardEvent[] = [];

  for (const [service, cs] of groups) {
    const amts = cs.map((c) => c.amount).filter((a): a is number => a !== null);
    const hasMarker = cs.some((c) => c.marker);
    const repAmount = amts.length ? amts[0] : null;
    const event: EventType =
      cs.map((c) => c.event).find((e) => e === "cancelled" || e === "payment_failed") ?? cs[0].event;
    const head = cs[0];
    const base = {
      serviceKey: service, serviceName: head.serviceName, serviceDomain: head.serviceDomain,
      amount: repAmount, currency: "USD", billingCycle: head.cycle, nextRenewal: head.nextRenewal,
      eventType: event, confidence: Math.max(...cs.map((c) => c.confidence)), evidenceCount: cs.length,
    };

    // Durable user override wins over everything.
    const override = overrides.get(service);
    if (override === "not_subscription") {
      corrobTrace.push({ tag: "L4 override", level: "fail", msg: `${service}: user marked not-a-subscription → rejected` });
      rejected.push({ ref: service, reason: "user override: not a subscription" });
      continue;
    }
    if (override === "subscription") {
      corrobTrace.push({ tag: "L4 override", level: "pass", msg: `${service}: user-confirmed → CONFIRMED` });
      results.push({ ...base, status: "active", reason: "user-confirmed subscription" });
      continue;
    }

    if (TRANSACTIONAL_STREAMS.has(service)) {
      const cv = amts.length > 1 ? stddev(amts) / mean(amts) : 0;
      const subDaily = gapsDays(cs.map((c) => c.date)).filter((d) => d < 1).length;
      corrobTrace.push({ tag: "L3 corrob", level: "fail",
        msg: `${service}: ${cs.length} charges, CV=${cv.toFixed(2)} (>${CV_CEILING}), ${subDaily} same-day gaps → REJECTED` });
      rejected.push({ ref: service, reason: `${cs.length} one-time orders, varying amounts (CV ${cv.toFixed(2)})` });
      continue;
    }

    if (hasMarker) {
      const dedup = cs.length > 1 ? ` (deduped ${cs.length} emails → 1)` : "";
      corrobTrace.push({ tag: "L3 corrob", level: "pass", msg: `${service}: explicit recurring marker${dedup} → CONFIRMED` });
      results.push({ ...base, status: "active", reason: cs.length > 1 ? `recurring marker; ${cs.length} emails deduped` : "explicit recurring marker" });
      continue;
    }

    if (cs.length < CORROBORATION_MIN) {
      corrobTrace.push({ tag: "L3 corrob", level: "info", msg: `${service}: single email, no marker → CANDIDATE` });
      results.push({ ...base, status: "candidate", reason: "single uncorroborated email" });
      continue;
    }

    const cv = stddev(amts) / mean(amts);
    const regular = isMonthlyCadence(gapsDays(cs.map((c) => c.date)));
    if (cv < CV_CEILING && regular) {
      corrobTrace.push({ tag: "L3 corrob", level: "pass", msg: `${service}: ${cs.length} stable charges (CV=${cv.toFixed(3)}), regular cadence → CONFIRMED` });
      results.push({ ...base, status: "active", reason: "stable repeat charges" });
    } else {
      corrobTrace.push({ tag: "L3 corrob", level: "fail", msg: `${service}: CV=${cv.toFixed(2)}, cadence ${regular ? "ok" : "irregular"} → REJECTED` });
      rejected.push({ ref: service, reason: `unstable repeat charges (CV ${cv.toFixed(2)})` });
    }
  }
  trace.push({ emailId: "__corroboration__", subject: "L3 corroboration", events: corrobTrace });

  // -------------------------------------------------------------------------
  // L5 — status routing
  // -------------------------------------------------------------------------
  const active: SubResult[] = [], pastDue: SubResult[] = [], ending: SubResult[] = [], candidates: SubResult[] = [];
  for (const r of results) {
    if (r.status === "candidate") { candidates.push(r); continue; }
    if (r.eventType === "cancelled") ending.push({ ...r, status: "ending" });
    else if (r.eventType === "payment_failed") pastDue.push({ ...r, status: "past_due" });
    else active.push(r);
  }

  const monthlyTotal = active.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  return { active, pastDue, ending, candidates, review, rejected, monthlyTotal, trace, evidence };
}
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/supabase.ts" << '__MBDEV_EOF__'
import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the service-role key — never import this into a
// client component. Single-user app: access is gated by being server-side.
export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
__MBDEV_EOF__

mkdir -p "$ROOT/lib"
cat > "$ROOT/lib/types.ts" << '__MBDEV_EOF__'
// Shared types for the extraction → guard → ledger pipeline.

export type EventType =
  | "charged" | "upcoming" | "payment_failed" | "cancelled" | "started" | "none";

export type BillingCycle =
  | "weekly" | "monthly" | "quarterly" | "annual" | "unknown";

// What the LLM returns for a single email. Validated by ExtractionSchema (Zod)
// in lib/guards.ts before any of it is trusted.
export interface Extraction {
  isSubscription: boolean;
  isPaymentProcessor: boolean;          // true for pure BNPL rails (Sezzle/Zip)
  serviceName: string | null;           // the real merchant, not the processor
  serviceDomain: string | null;
  amount: { value: string; quote: string } | null; // value + the literal text it came from
  currency: string | null;
  billingCycle: BillingCycle;
  billingPeriod: { start: string; end: string } | null;
  nextRenewal: string | null;
  eventType: EventType;
  hasRecurringMarker: boolean;          // explicit subscription / auto-renew / Stripe Billing
  confidence: number;                   // 0..1
}

// The minimal email shape the pipeline needs (built from the Gmail API).
export interface EmailMeta {
  id: string;            // gmail message id
  fromName: string;
  fromDomain: string;
  subject: string;
  date: string;          // ISO
  bodyText: string;
}

export interface PipelineInput {
  email: EmailMeta;
  extraction: unknown;   // unknown until Zod-validated inside the pipeline
}

export type GuardLevel = "pass" | "fail" | "info";
export interface GuardEvent { tag: string; level: GuardLevel; msg: string }
export interface EmailTrace { emailId: string; subject: string; events: GuardEvent[] }

export interface SubResult {
  serviceKey: string;
  serviceName: string;
  serviceDomain: string | null;
  status: "active" | "past_due" | "ending" | "candidate";
  amount: number | null;       // dollars; null = known sub, unknown price
  currency: string;
  billingCycle: BillingCycle;
  nextRenewal: string | null;
  eventType: EventType;
  confidence: number;
  evidenceCount: number;
  reason: string;
}

export interface ReviewResult { messageId: string; serviceKey: string | null; reason: string; raw: unknown }
export interface RejectResult { ref: string; reason: string }

export interface LedgerResult {
  active: SubResult[];
  pastDue: SubResult[];
  ending: SubResult[];
  candidates: SubResult[];
  review: ReviewResult[];
  rejected: RejectResult[];
  monthlyTotal: number;        // dollars
  trace: EmailTrace[];
  // flat evidence rows for persistence
  evidence: {
    messageId: string; serviceKey: string; fromName: string; fromDomain: string;
    subject: string; receivedAt: string; amount: number | null; currency: string | null;
    eventType: EventType; quote: string | null; confidence: number;
  }[];
}
__MBDEV_EOF__

mkdir -p "$ROOT"
cat > "$ROOT/next.config.mjs" << '__MBDEV_EOF__'
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
__MBDEV_EOF__

mkdir -p "$ROOT"
cat > "$ROOT/package.json" << '__MBDEV_EOF__'
{
  "name": "subtracker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "verify:guards": "tsx scripts/verify-guards.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@supabase/supabase-js": "^2.45.0",
    "next": "^15.3.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tsx": "^4.22.4",
    "typescript": "^5.6.0"
  }
}
__MBDEV_EOF__

mkdir -p "$ROOT/scripts"
cat > "$ROOT/scripts/verify-guards.ts" << '__MBDEV_EOF__'
// Proves the ported guard pipeline (lib/guards.ts) produces the same
// classifications as the verified prototype. Run: npm run verify:guards
import { runPipeline } from "../lib/guards";
import { PipelineInput, Extraction, EmailMeta } from "../lib/types";

const base: Extraction = {
  isSubscription: false, isPaymentProcessor: false, serviceName: null, serviceDomain: null,
  amount: null, currency: null, billingCycle: "unknown", billingPeriod: null,
  nextRenewal: null, eventType: "none", hasRecurringMarker: false, confidence: 0.5,
};
const mk = (e: Partial<EmailMeta>, x: Partial<Extraction>): PipelineInput => ({
  email: { id: e.id!, fromName: e.fromName ?? "", fromDomain: e.fromDomain ?? "",
           subject: e.subject ?? "", date: e.date ?? "2026-06-15T10:00", bodyText: e.bodyText ?? "" },
  extraction: { ...base, ...x },
});

const uber = (id: string, date: string, amt: string) =>
  mk({ id, fromName: "Uber Receipts", fromDomain: "uber.com", subject: "Your order with Uber Eats",
       date, bodyText: `receipt. Total US${amt}.` },
     { serviceName: "Uber Eats", amount: { value: amt, quote: `Total US${amt}` }, eventType: "charged", confidence: 0.4 });

const inputs: PipelineInput[] = [
  uber("u1", "2026-06-20T12:25", "$68.45"), uber("u2", "2026-06-19T17:00", "$121.20"),
  uber("u3", "2026-06-18T08:30", "$81.75"), uber("u4", "2026-06-17T19:15", "$72.35"),
  uber("u5", "2026-06-15T16:48", "$102.42"), uber("u6", "2026-06-14T11:12", "$24.62"),

  mk({ id: "vons", fromName: "Vons", fromDomain: "p.vons.com", subject: "Your FreshPass Subscription is Renewing Soon",
       bodyText: "your card will be charged $12.99 + tax. You have saved $59.75 so far. Plan Price: $12.99. Auto-Renewal Date: 06/23/2026. annual subscribers get a $5 monthly credit - a $60 value. delivery on orders over $30." },
     { isSubscription: true, serviceName: "Vons FreshPass", amount: { value: "$12.99", quote: "Plan Price: $12.99. Auto-Renewal Date: 06/23/2026" }, billingCycle: "monthly", eventType: "upcoming", hasRecurringMarker: true, confidence: 0.95 }),

  mk({ id: "reddit-b", fromName: "Reddit", fromDomain: "redditmail.com", subject: "Your Reddit Premium Subscription has been renewed",
       bodyText: "charged $5.99 (USD)." },
     { isSubscription: true, serviceName: "Reddit Premium", amount: { value: "$5.99", quote: "charged $5.99 (USD)" }, billingCycle: "monthly", eventType: "charged", hasRecurringMarker: true, confidence: 0.96 }),
  mk({ id: "reddit-s", fromName: "Reddit, Inc.", fromDomain: "stripe.com", subject: "Your receipt from Reddit, Inc. #2330-8535",
       bodyText: "Receipt from Reddit, Inc. $5.99 Paid. Powered by Stripe Billing." },
     { isSubscription: true, serviceName: "Reddit, Inc.", amount: { value: "$5.99", quote: "Receipt from Reddit, Inc. $5.99 Paid" }, billingCycle: "monthly", eventType: "charged", hasRecurringMarker: true, confidence: 0.9 }),

  mk({ id: "rork", fromName: "Rork, Inc.", fromDomain: "stripe.com", subject: "Your receipt from Rork, Inc. #2998-3038",
       bodyText: "Receipt from Rork, Inc. Amount paid $20.00. Powered by Stripe Billing." },
     { isSubscription: true, serviceName: "Rork, Inc.", amount: { value: "$20.00", quote: "Amount paid $20.00" }, billingCycle: "monthly", eventType: "charged", hasRecurringMarker: true, confidence: 0.92 }),

  mk({ id: "chatgpt", fromName: "OpenAI", fromDomain: "openai.com", subject: "ChatGPT - Your plan will not renew",
       bodyText: "Your ChatGPT Plus subscription will not renew." },
     { isSubscription: true, serviceName: "ChatGPT Plus", billingCycle: "monthly", eventType: "cancelled", hasRecurringMarker: true, confidence: 0.9 }),

  mk({ id: "grammarly", fromName: "Grammarly", fromDomain: "grammarly.com", subject: "PAYMENT FAILED: update your Grammarly subscription",
       bodyText: "update your payment method to keep your Grammarly subscription." },
     { isSubscription: true, serviceName: "Grammarly", eventType: "payment_failed", hasRecurringMarker: true, confidence: 0.82 }),

  mk({ id: "sezzle", fromName: "Sezzle", fromDomain: "sezzle.com", subject: "Thank you for paying with Sezzle!",
       bodyText: "gift card purchased." },
     { isSubscription: true, isPaymentProcessor: true, serviceName: "Sezzle", eventType: "charged", confidence: 0.5 }),

  mk({ id: "webroot", fromName: "Best Buy", fromDomain: "bestbuy.com", subject: "Install your Webroot Internet Security Software",
       bodyText: "install your security software." },
     { isSubscription: true, serviceName: "Webroot Internet Security", billingCycle: "annual", eventType: "none", confidence: 0.45 }),

  mk({ id: "battlenet", fromName: "Battle.net", fromDomain: "blizzard.com", subject: "Your Order From Battle.net",
       bodyText: "You purchased Midnight Epic Edition." },
     { isSubscription: false, serviceName: "Battle.net", eventType: "none", confidence: 0.2 }),

  // malformed extraction → must be caught by Zod
  { email: { id: "bad", fromName: "X", fromDomain: "x.com", subject: "Receipt", date: "2026-06-12T10:00", bodyText: "" },
    extraction: { isSubscription: "yes", confidence: 1.4 } },
];

const L = runPipeline(inputs);

const has = (arr: { serviceKey: string }[], k: string) => arr.some((s) => s.serviceKey === k);
const checks: [string, boolean][] = [
  ["Uber Eats rejected (variance)", L.rejected.some((r) => r.ref === "uber-eats-orders")],
  ["Vons confirmed @ $12.99 (decoys ignored)", has(L.active, "vons-freshpass") && L.active.find((s) => s.serviceKey === "vons-freshpass")?.amount === 12.99],
  ["Reddit deduped to one sub", L.active.filter((s) => s.serviceKey === "reddit-premium").length === 1 && L.active.find((s) => s.serviceKey === "reddit-premium")?.evidenceCount === 2],
  ["Rork unwrapped from stripe.com @ $20", has(L.active, "rork") && L.active.find((s) => s.serviceKey === "rork")?.amount === 20],
  ["ChatGPT routed to ending", has(L.ending, "chatgpt-plus")],
  ["Grammarly routed to past-due", has(L.pastDue, "grammarly")],
  ["Sezzle rejected (payment rail)", L.rejected.some((r) => r.ref === "sezzle")],
  ["Webroot → review (low confidence)", L.review.some((r) => r.serviceKey === "webroot-internet-security")],
  ["Battle.net rejected (one-time)", L.rejected.some((r) => r.ref === "battlenet")],
  ["Malformed → review (Zod)", L.review.some((r) => r.messageId === "bad")],
];

console.log("\nLEDGER");
console.log(`  active:     ${L.active.map((s) => `${s.serviceKey}${s.amount !== null ? " $" + s.amount : ""}`).join(", ")}`);
console.log(`  past due:   ${L.pastDue.map((s) => s.serviceKey).join(", ") || "—"}`);
console.log(`  ending:     ${L.ending.map((s) => s.serviceKey).join(", ") || "—"}`);
console.log(`  review:     ${L.review.map((r) => r.serviceKey ?? r.messageId).join(", ") || "—"}`);
console.log(`  rejected:   ${L.rejected.map((r) => r.ref).join(", ") || "—"}`);
console.log(`  monthly total: $${L.monthlyTotal.toFixed(2)}\n`);

let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "PASS " : "FAIL "} ${name}`);
  if (!pass) ok = false;
}
console.log(`\n${ok ? "ALL GUARDS VERIFIED — port is faithful." : "PORT REGRESSION DETECTED."}\n`);
process.exit(ok ? 0 : 1);
__MBDEV_EOF__

mkdir -p "$ROOT/supabase/migrations"
cat > "$ROOT/supabase/migrations/0001_init.sql" << '__MBDEV_EOF__'
-- ============================================================================
-- Subscription tracker — initial schema
-- Money is stored as integer cents everywhere to avoid floating-point drift.
-- ============================================================================

-- Connected Gmail account(s). Refresh token is AES-256-GCM encrypted at rest;
-- the server never stores it in plaintext. Single-user today, but keyed for more.
create table if not exists gmail_accounts (
  id                      uuid primary key default gen_random_uuid(),
  email                   text not null unique,
  enc_refresh_token       text not null,   -- base64 ciphertext
  enc_iv                  text not null,   -- base64 iv
  enc_tag                 text not null,   -- base64 auth tag
  scopes                  text not null default 'gmail.readonly',
  last_scan_at            timestamptz,
  created_at              timestamptz not null default now()
);

-- Rolled-up subscriptions. One row per normalized service.
create table if not exists subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  service_key             text not null unique,         -- 'vons-freshpass', normalized
  service_name            text not null,                -- 'Vons FreshPass'
  service_domain          text,                         -- resolved from body, not sender
  amount_cents            integer,                      -- null = known sub, unknown price
  currency                text default 'USD',
  billing_cycle           text not null default 'unknown',
    constraint billing_cycle_chk check (billing_cycle in
      ('weekly','monthly','quarterly','annual','unknown')),
  status                  text not null default 'candidate',
    constraint status_chk check (status in
      ('active','past_due','ending','dormant','candidate')),
  next_renewal            date,
  category                text,
  cancel_url              text,
  confidence              real,
  evidence_count          integer not null default 0,   -- how many emails corroborate it
  first_seen              timestamptz,
  last_seen               timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Raw, per-email signals. Separated from the rollup so we can show payment
-- history, detect price changes, and re-derive subscriptions if guards improve.
create table if not exists charge_evidence (
  id                      uuid primary key default gen_random_uuid(),
  gmail_message_id        text not null unique,          -- idempotency key for scans
  subscription_id         uuid references subscriptions(id) on delete set null,
  service_key             text not null,
  from_name               text,
  from_domain             text,
  subject                 text,
  received_at             timestamptz not null,
  amount_cents            integer,                       -- grounded amount, or null
  currency                text,
  event_type              text not null default 'none',
    constraint event_type_chk check (event_type in
      ('charged','upcoming','payment_failed','cancelled','started','none')),
  amount_quote            text,                          -- the literal text the amount came from
  raw_confidence          real,
  created_at              timestamptz not null default now()
);

-- Anything the guards couldn't safely confirm. The user resolves these; the
-- resolution is remembered in service_overrides so it never has to be asked twice.
create table if not exists review_items (
  id                      uuid primary key default gen_random_uuid(),
  gmail_message_id        text not null unique,
  service_key             text,
  reason                  text not null,                 -- why it landed here
  raw                     jsonb,                         -- the full extraction for context
  status                  text not null default 'pending',
    constraint review_status_chk check (status in ('pending','confirmed','rejected')),
  resolved_service_key    text,
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz
);

-- The learning loop. A user decision about a service is durable, so the same
-- ambiguous pattern auto-resolves on every future scan.
create table if not exists service_overrides (
  service_key             text primary key,
  decision                text not null,
    constraint decision_chk check (decision in ('subscription','not_subscription')),
  note                    text,
  created_at              timestamptz not null default now()
);

-- One row per scan, for history and the dashboard's "last scanned" line.
create table if not exists scan_runs (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid references gmail_accounts(id) on delete cascade,
  started_at              timestamptz not null default now(),
  finished_at             timestamptz,
  emails_scanned          integer not null default 0,
  emails_new              integer not null default 0,
  n_active                integer not null default 0,
  n_past_due              integer not null default 0,
  n_ending                integer not null default 0,
  n_review                integer not null default 0,
  n_rejected              integer not null default 0,
  error                   text
);

create index if not exists idx_evidence_service on charge_evidence(service_key);
create index if not exists idx_evidence_received on charge_evidence(received_at desc);
create index if not exists idx_subs_status on subscriptions(status);
create index if not exists idx_review_status on review_items(status);

-- Single-user app: access is via the service-role key from the server only.
-- If this ever goes multi-user, enable RLS here and scope every table by user_id.
__MBDEV_EOF__

mkdir -p "$ROOT"
cat > "$ROOT/tsconfig.json" << '__MBDEV_EOF__'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
__MBDEV_EOF__

echo "Done. Next: cd $ROOT && cp .env.example .env && npm install"
