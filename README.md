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
   → PDF fallback fills any missing amounts        lib/pdf.ts
   → ledger persisted to Postgres                  lib/scan.ts
```

The scan runs two ways: **manually** from the dashboard (`POST /api/scan`) and on a
**daily cron** (`GET /api/cron/scan`, wired in `vercel.json`). Both call the same
`runScan()` in `lib/scan.ts`, which is idempotent on `gmail_message_id`.

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

### Beyond the guards

- **PDF amounts.** A few processors (notably Paddle) send a body-less receipt
  where the price lives only in an attached PDF; those subs surface as *needs PDF*.
  After the guards run, `lib/pdf.ts` fetches the attachment and reads the amount
  out of it using the **same** charge-context selector the guards apply to email
  bodies — so the decoy rules hold. It's best-effort: if the PDF can't be read,
  the sub stays *needs PDF* rather than showing a guessed price.
- **Scheduled scans.** `GET /api/cron/scan` runs the full pipeline daily via
  `vercel.json` crons. It's guarded by `CRON_SECRET` (Vercel sends it as a bearer
  token automatically).
- **Price-change detection.** Corroboration uses the *most recent* grounded charge
  as the current price and records the prior distinct price + when it moved. The
  dashboard shows `↑ from $8.00`; the history page shows the full timeline.
- **Per-subscription history.** Click any row to see every receipt behind it
  (`/sub/[id]`) — date, event, amount, and the literal text each amount came from.
- **CSV export.** `GET /api/export` downloads the whole ledger (`export csv` on the
  dashboard).

## Setup

### 1. Supabase
Create a project, then run the migrations in `supabase/migrations/` in order
(`0001_init.sql` then `0002_features.sql` — SQL editor, or `supabase db push`).
Copy the project URL and the **service-role** key into `.env`.

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
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"     # CRON_SECRET (prod)
```
`CRON_SECRET` is optional locally; set it in production so the daily cron endpoint
can't be triggered by anyone else.

**Secret guard.** Every `.env*` file is gitignored (except `.env.example`), and a
committed pre-commit hook (`.githooks/pre-commit`) refuses to commit any env file
or key/token — even via `git add -f`. Enable it in a fresh clone with:
```bash
git config core.hooksPath .githooks
```

### 4. Run
```bash
npm install
npm run dev
```
Open `http://localhost:3000`, click **Connect Gmail**, then **Scan inbox**.

Useful scripts:
```bash
npm run verify:guards   # run the guard suite against real-email fixtures
npm run build           # production build + type-check
```

> Versions in `package.json` are indicative — if the Anthropic SDK or Supabase
> client has moved, `npm install @anthropic-ai/sdk@latest @supabase/supabase-js@latest`.

## File map

```
supabase/migrations/
  0001_init.sql   schema (cents, evidence split, overrides)
  0002_features.sql  price-change columns on subscriptions
lib/
  gmail.ts        OAuth refresh, search, MIME decode, attachment fetch (read-only)
  extract.ts      the tuned Claude prompt + forced tool-call (lazy client)
  guards.ts       the five-layer pipeline (pure, testable)
  pdf.ts          PDF amount fallback for body-less receipts
  scan.ts         the orchestrator: Gmail → extract → guards → PDF → persist
  crypto.ts       AES-256-GCM for the refresh token at rest
  supabase.ts     server client (service role)
  types.ts        shared types
app/
  page.tsx        the ledger dashboard
  sub/[id]/page.tsx  per-subscription payment history
  actions.tsx     scan + review client actions
  api/auth/google/…  OAuth start + callback
  api/scan/route.ts  manual scan (POST → runScan)
  api/cron/scan/route.ts  scheduled scan (GET, CRON_SECRET-guarded)
  api/review/route.ts review resolution + learning loop
  api/export/route.ts  CSV export of the ledger
vercel.json       daily cron wiring
scripts/verify-guards.ts  proves the guards on real fixtures
```

## Known next steps
- **Multi-account / RLS.** Schema is keyed for it; enable RLS and scope by user_id
  if this ever leaves single-user.
- **Cancel links.** `subscriptions.cancel_url` exists in the schema but isn't yet
  populated or surfaced — a "cancel" affordance per sub is a natural addition.
