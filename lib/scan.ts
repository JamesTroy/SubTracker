import { decrypt } from "./crypto";
import { supabaseAdmin } from "./supabase";
import { getAccessToken, searchMessageIds, getMessage, CANDIDATE_QUERY, TokenError } from "./gmail";
import { extractFromEmail } from "./extract";
import { runPipeline } from "./guards";
import { extractPdfAmount } from "./pdf";
import { PipelineInput } from "./types";

const dollarsToCents = (d: number | null) => (d === null ? null : Math.round(d * 100));

// Free-form LLM dates ("July 2026", "in 30 days") must NOT reach a `date` column —
// a parse error there would abort the whole persist. Coerce to YYYY-MM-DD or null.
const toDateOrNull = (v: string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

type FetchedEmail = Awaited<ReturnType<typeof getMessage>>;

// Status strength, so a partial re-scan can never downgrade a confirmed sub.
const STATUS_RANK: Record<string, number> = { candidate: 0, ending: 1, past_due: 2, active: 3 };

// Live progress, streamed to the client so the Scan button can show a tracker.
export type ScanProgress =
  | { phase: "search" }
  | { phase: "fetch"; done: number; total: number }
  | { phase: "persist" };

export type ScanOutcome =
  | {
      ok: true;
      scanned: number; new: number; active: number; pastDue: number; ending: number;
      review: number; rejected: number; pdfResolved: number; failed: number;
      truncated: boolean; monthlyTotal: number;
    }
  | { ok: false; status: number; error: string; reconnect?: boolean };

type Ev = { amount_cents: number | null; received_at: string };

// Roll a service's full all-time evidence series (DB + this run) into the
// subscription columns, so a re-scan that sees only some of a service's emails
// can never shrink evidence_count, drop the amount, or erase a price change.
function rollup(series: Ev[]) {
  const sorted = [...series].sort((a, b) => +new Date(a.received_at) - +new Date(b.received_at));
  const priced = sorted.filter((r): r is { amount_cents: number; received_at: string } => r.amount_cents != null);
  const amount = priced.length ? priced[priced.length - 1].amount_cents : null;
  let previous: number | null = null;
  let changedAt: string | null = null;
  if (amount != null) {
    for (let i = priced.length - 2; i >= 0; i--) {
      if (priced[i].amount_cents !== amount) { previous = priced[i].amount_cents; changedAt = priced[i + 1].received_at; break; }
    }
  }
  return {
    amount_cents: amount,
    previous_amount_cents: previous,
    price_changed_at: changedAt,
    evidence_count: sorted.length,
    last_seen: sorted.length ? sorted[sorted.length - 1].received_at : new Date().toISOString(),
  };
}

// The whole scan pipeline: Gmail → extract → guards → PDF fallback → persist.
// Idempotent on gmail_message_id. Shared by POST /api/scan and the cron route.
// Every DB call is error-checked: a failed write throws into the catch and is
// recorded + surfaced, never a silent partial-success.
export async function runScan(onProgress: (p: ScanProgress) => void = () => {}): Promise<ScanOutcome> {
  const db = supabaseAdmin();

  const { data: account, error: acctErr } = await db.from("gmail_accounts").select("*").limit(1).maybeSingle();
  if (acctErr) return { ok: false, status: 500, error: `account lookup: ${acctErr.message}` };
  if (!account) return { ok: false, status: 400, error: "No Gmail account connected" };

  // Concurrency guard: don't let cron + manual (or a double-fire) both scan at once
  // and double the Anthropic spend. Single-user, so a cheap recent-open-run check.
  const { data: openRun } = await db.from("scan_runs")
    .select("id, started_at").eq("account_id", account.id).is("finished_at", null)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (openRun && Date.now() - new Date(openRun.started_at).getTime() < 10 * 60_000) {
    return { ok: false, status: 409, error: "A scan is already running — try again in a moment." };
  }

  const { data: run, error: runErr } = await db
    .from("scan_runs").insert({ account_id: account.id }).select("id").single();
  if (runErr || !run) return { ok: false, status: 500, error: `Could not open scan run: ${runErr?.message ?? "unknown"}` };
  const runId = run.id;

  try {
    const accessToken = await getAccessToken(
      decrypt(account.enc_refresh_token, account.enc_iv, account.enc_tag),
    );

    // Find candidates (capped); skip ones already processed (idempotency).
    onProgress({ phase: "search" });
    const { ids: allIds, truncated } = await searchMessageIds(accessToken, CANDIDATE_QUERY);
    const newIds: string[] = [];
    for (const batch of chunk(allIds, 200)) {
      // seen-set = every previously PROCESSED message (not just evidence-backed),
      // so rejected/dropped emails aren't re-fetched + re-extracted every scan.
      const { data: seen, error } = await db
        .from("scanned_messages").select("gmail_message_id").in("gmail_message_id", batch);
      if (error) throw new Error(`seen lookup: ${error.message}`);
      const seenSet = new Set((seen ?? []).map((r) => r.gmail_message_id));
      for (const id of batch) if (!seenSet.has(id)) newIds.push(id);
    }

    // Fetch + extract each new email. allSettled: one bad email/Anthropic hiccup is
    // skipped + counted, never fatal to the whole scan.
    const inputs: PipelineInput[] = [];
    const emailById = new Map<string, FetchedEmail>();
    let failed = 0;
    let processed = 0;
    if (newIds.length) onProgress({ phase: "fetch", done: 0, total: newIds.length });
    for (const batch of chunk(newIds, 5)) {
      const settled = await Promise.allSettled(
        batch.map(async (id) => {
          const email = await getMessage(accessToken, id);
          emailById.set(id, email);
          const extraction = await extractFromEmail(email);
          return { email, extraction };
        }),
      );
      for (const s of settled) {
        if (s.status === "fulfilled") inputs.push(s.value);
        else { failed++; console.error("[scan] email failed:", s.reason instanceof Error ? s.reason.message : s.reason); }
      }
      processed += batch.length;
      onProgress({ phase: "fetch", done: Math.min(processed, newIds.length), total: newIds.length });
    }

    // Durable user decisions (the learning loop). Fail loudly if it can't be read —
    // silently bypassing overrides would resurrect services the user rejected.
    const { data: ov, error: ovErr } = await db.from("service_overrides").select("*");
    if (ovErr) throw new Error(`overrides read: ${ovErr.message}`);
    const overrides = new Map<string, "subscription" | "not_subscription">(
      (ov ?? []).map((o) => [o.service_key, o.decision]),
    );
    const ledger = runPipeline(inputs, overrides);

    // PDF amount fallback for confirmed subs with no grounded price. Best-effort.
    let pdfResolved = 0;
    for (const sub of [...ledger.active, ...ledger.pastDue]) {
      if (sub.amount !== null) continue;
      for (const e of ledger.evidence) {
        if (e.serviceKey !== sub.serviceKey) continue;
        const msg = emailById.get(e.messageId);
        if (!msg?.pdfAttachmentId) continue;
        const got = await extractPdfAmount(accessToken, e.messageId, msg.pdfAttachmentId).catch(() => null);
        if (got) { sub.amount = got.amount; e.amount = got.amount; e.quote = got.quote; pdfResolved++; break; }
      }
    }
    const monthlyTotal = ledger.active.reduce((t, s) => t + (s.amount ?? 0), 0);
    onProgress({ phase: "persist" });

    // --- Persist (all error-checked) ---------------------------------------
    const now = new Date().toISOString();
    const allSubs = [...ledger.active, ...ledger.pastDue, ...ledger.ending, ...ledger.candidates];
    const keys = [...new Set(allSubs.map((s) => s.serviceKey))];

    // Pull existing subs (for anti-regression status) and existing evidence (so
    // rollups reflect the ALL-TIME series, not just this run's emails).
    const existingStatus = new Map<string, string>();
    const evByKey = new Map<string, Ev[]>();
    if (keys.length) {
      const [{ data: exSubs, error: e1 }, { data: exEv, error: e2 }] = await Promise.all([
        db.from("subscriptions").select("service_key, status").in("service_key", keys),
        db.from("charge_evidence").select("service_key, amount_cents, received_at").in("service_key", keys),
      ]);
      if (e1) throw new Error(`subscriptions read: ${e1.message}`);
      if (e2) throw new Error(`evidence read: ${e2.message}`);
      for (const r of exSubs ?? []) existingStatus.set(r.service_key, r.status);
      for (const r of exEv ?? []) (evByKey.get(r.service_key) ?? evByKey.set(r.service_key, []).get(r.service_key)!).push(r);
    }
    // Merge this run's new evidence into the per-service series.
    for (const e of ledger.evidence) {
      if (!keys.includes(e.serviceKey)) continue;
      (evByKey.get(e.serviceKey) ?? evByKey.set(e.serviceKey, []).get(e.serviceKey)!)
        .push({ amount_cents: dollarsToCents(e.amount), received_at: e.receivedAt });
    }

    // 1) Upsert subscriptions (mints ids), with all-time rollups + anti-regression status.
    const subRows = allSubs.map((s) => {
      const ex = existingStatus.get(s.serviceKey);
      let status: string = s.status;
      if (ex && (STATUS_RANK[ex] ?? 0) > (STATUS_RANK[s.status] ?? 0) && s.evidenceCount < 2) status = ex;
      const roll = rollup(evByKey.get(s.serviceKey) ?? []);
      return {
        service_key: s.serviceKey, service_name: s.serviceName, service_domain: s.serviceDomain,
        amount_cents: roll.amount_cents, previous_amount_cents: roll.previous_amount_cents,
        price_changed_at: roll.price_changed_at, currency: s.currency, billing_cycle: s.billingCycle,
        status, next_renewal: toDateOrNull(s.nextRenewal), confidence: s.confidence,
        evidence_count: roll.evidence_count, last_seen: roll.last_seen, updated_at: now,
      };
    });
    if (subRows.length) {
      const { error } = await db.from("subscriptions").upsert(subRows, { onConflict: "service_key" });
      if (error) throw new Error(`subscriptions upsert: ${error.message}`);
    }

    // ids for evidence linkage
    const subIdByKey = new Map<string, string>();
    if (keys.length) {
      const { data: stored, error } = await db.from("subscriptions").select("id, service_key").in("service_key", keys);
      if (error) throw new Error(`subscriptions id read: ${error.message}`);
      for (const r of stored ?? []) subIdByKey.set(r.service_key, r.id);
    }

    // 2) Evidence (idempotent on gmail_message_id), linked to its sub.
    const evRows = ledger.evidence.map((e) => ({
      gmail_message_id: e.messageId, subscription_id: subIdByKey.get(e.serviceKey) ?? null,
      service_key: e.serviceKey, from_name: e.fromName, from_domain: e.fromDomain, subject: e.subject,
      received_at: e.receivedAt, amount_cents: dollarsToCents(e.amount), currency: e.currency,
      event_type: e.eventType, amount_quote: e.quote, raw_confidence: e.confidence,
    }));
    if (evRows.length) {
      const { error } = await db.from("charge_evidence").upsert(evRows, { onConflict: "gmail_message_id" });
      if (error) throw new Error(`charge_evidence upsert: ${error.message}`);
    }

    // 3) Review queue.
    const reviewRows = ledger.review.map((r) => ({
      gmail_message_id: r.messageId, service_key: r.serviceKey, reason: r.reason, raw: r.raw as object,
    }));
    if (reviewRows.length) {
      const { error } = await db.from("review_items").upsert(reviewRows, { onConflict: "gmail_message_id" });
      if (error) throw new Error(`review_items upsert: ${error.message}`);
    }

    // Remember every email we actually processed (evidence, review, OR dropped) so
    // it's never re-fetched/re-extracted. Failed (threw) emails aren't recorded → retry.
    const processedIds = inputs.map((i) => i.email.id);
    if (processedIds.length) {
      const { error } = await db.from("scanned_messages")
        .upsert(processedIds.map((id) => ({ gmail_message_id: id })), { onConflict: "gmail_message_id", ignoreDuplicates: true });
      if (error) throw new Error(`scanned_messages upsert: ${error.message}`);
    }

    const { error: srErr } = await db.from("scan_runs").update({
      finished_at: now, emails_scanned: allIds.length, emails_new: newIds.length,
      n_active: ledger.active.length, n_past_due: ledger.pastDue.length, n_ending: ledger.ending.length,
      n_review: ledger.review.length, n_rejected: ledger.rejected.length, n_failed: failed,
    }).eq("id", runId);
    if (srErr) throw new Error(`scan_run update: ${srErr.message}`);
    const { error: acErr } = await db.from("gmail_accounts").update({ last_scan_at: now }).eq("id", account.id);
    if (acErr) throw new Error(`account update: ${acErr.message}`);

    return {
      ok: true,
      scanned: allIds.length, new: newIds.length,
      active: ledger.active.length, pastDue: ledger.pastDue.length, ending: ledger.ending.length,
      review: ledger.review.length, rejected: ledger.rejected.length,
      pdfResolved, failed, truncated, monthlyTotal,
    };
  } catch (e: unknown) {
    const reconnect = e instanceof TokenError;
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("scan_runs").update({ finished_at: new Date().toISOString(), error: msg }).eq("id", runId);
    return { ok: false, status: reconnect ? 401 : 500, error: msg, reconnect };
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
