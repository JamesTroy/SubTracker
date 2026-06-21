import { decrypt } from "./crypto";
import { supabaseAdmin } from "./supabase";
import { getAccessToken, searchMessageIds, getMessage, CANDIDATE_QUERY } from "./gmail";
import { extractFromEmail } from "./extract";
import { runPipeline } from "./guards";
import { extractPdfAmount } from "./pdf";
import { PipelineInput, SubResult } from "./types";

const dollarsToCents = (d: number | null) => (d === null ? null : Math.round(d * 100));

type FetchedEmail = Awaited<ReturnType<typeof getMessage>>;

export type ScanOutcome =
  | {
      ok: true;
      scanned: number;
      new: number;
      active: number;
      pastDue: number;
      ending: number;
      review: number;
      rejected: number;
      pdfResolved: number;
      monthlyTotal: number;
    }
  | { ok: false; status: number; error: string };

// The whole scan pipeline as one pure-ish function: Gmail → extract → guards →
// PDF fallback → persist. Idempotent on gmail_message_id. Shared by the manual
// POST /api/scan route and the scheduled GET /api/cron/scan route.
export async function runScan(): Promise<ScanOutcome> {
  const db = supabaseAdmin();

  const { data: account } = await db.from("gmail_accounts").select("*").limit(1).maybeSingle();
  if (!account) return { ok: false, status: 400, error: "No Gmail account connected" };

  const { data: run, error: runErr } = await db
    .from("scan_runs").insert({ account_id: account.id }).select("id").single();
  if (runErr || !run) {
    return { ok: false, status: 500, error: `Could not open scan run: ${runErr?.message ?? "unknown"}` };
  }
  const runId = run.id;

  try {
    const accessToken = await getAccessToken(
      decrypt(account.enc_refresh_token, account.enc_iv, account.enc_tag),
    );

    // Find candidates, skip ones we've already processed.
    const allIds = await searchMessageIds(accessToken, CANDIDATE_QUERY);
    const newIds: string[] = [];
    // Gmail returns at most a few hundred ids; chunk the `in` filter to stay
    // well under Postgres/PostgREST URL limits.
    for (const batch of chunk(allIds, 200)) {
      const { data: seen } = await db
        .from("charge_evidence").select("gmail_message_id").in("gmail_message_id", batch);
      const seenSet = new Set((seen ?? []).map((r) => r.gmail_message_id));
      for (const id of batch) if (!seenSet.has(id)) newIds.push(id);
    }

    // Fetch + extract each new email (bounded concurrency keeps API load sane).
    const inputs: PipelineInput[] = [];
    const emailById = new Map<string, FetchedEmail>();
    for (const batch of chunk(newIds, 5)) {
      const settled = await Promise.all(
        batch.map(async (id) => {
          const email = await getMessage(accessToken, id);
          emailById.set(id, email);
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

    // --- PDF amount fallback ------------------------------------------------
    // For confirmed subs with no grounded price, if any of their evidence emails
    // carried a PDF attachment, read the amount out of it. Best-effort.
    let pdfResolved = 0;
    const confirmed = [...ledger.active, ...ledger.pastDue];
    for (const sub of confirmed) {
      if (sub.amount !== null) continue;
      for (const e of ledger.evidence) {
        if (e.serviceKey !== sub.serviceKey) continue;
        const msg = emailById.get(e.messageId);
        if (!msg?.pdfAttachmentId) continue;
        const got = await extractPdfAmount(accessToken, e.messageId, msg.pdfAttachmentId).catch(() => null);
        if (got) {
          sub.amount = got.amount;
          e.amount = got.amount;
          e.quote = got.quote;
          pdfResolved++;
          break;
        }
      }
    }
    const monthlyTotal = ledger.active.reduce((t, s) => t + (s.amount ?? 0), 0);

    // --- Persist -----------------------------------------------------------
    // 1) Upsert subscriptions (active + past_due + ending + candidates).
    const now = new Date().toISOString();
    const allSubs: SubResult[] = [
      ...ledger.active, ...ledger.pastDue, ...ledger.ending, ...ledger.candidates,
    ];
    const subRows = allSubs.map((s) => ({
      service_key: s.serviceKey, service_name: s.serviceName, service_domain: s.serviceDomain,
      amount_cents: dollarsToCents(s.amount), previous_amount_cents: dollarsToCents(s.previousAmount),
      price_changed_at: s.priceChangedAt, currency: s.currency, billing_cycle: s.billingCycle,
      status: s.status, next_renewal: s.nextRenewal, confidence: s.confidence,
      evidence_count: s.evidenceCount, last_seen: now, updated_at: now,
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
      finished_at: now, emails_scanned: allIds.length, emails_new: newIds.length,
      n_active: ledger.active.length, n_past_due: ledger.pastDue.length, n_ending: ledger.ending.length,
      n_review: ledger.review.length, n_rejected: ledger.rejected.length,
    }).eq("id", runId);
    await db.from("gmail_accounts").update({ last_scan_at: now }).eq("id", account.id);

    return {
      ok: true,
      scanned: allIds.length, new: newIds.length,
      active: ledger.active.length, pastDue: ledger.pastDue.length, ending: ledger.ending.length,
      review: ledger.review.length, rejected: ledger.rejected.length,
      pdfResolved, monthlyTotal,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("scan_runs").update({ finished_at: new Date().toISOString(), error: msg }).eq("id", runId);
    return { ok: false, status: 500, error: msg };
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
