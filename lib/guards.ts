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
// charge language and away from savings/credit/threshold language. Also reused
// by the PDF fallback (lib/pdf.ts) to read an amount out of a receipt PDF.
const CHARGE_KW = /charged|plan price|amount paid|amount due|total|billed|price/i;
const EXCLUDE_KW = /saved|savings|credit|value|off|over \$|free delivery|orders over/i;
export function pickChargeAmount(body: string): { amount: number; quote: string } | null {
  let best: { amount: number; score: number; quote: string } | null = null; let m; const re = new RegExp(MONEY);
  while ((m = re.exec(body)) !== null) {
    const amt = Number(m[1].replace(/,/g, ""));
    const quote = body.slice(Math.max(0, m.index - 45), m.index + 25).replace(/\s+/g, " ").trim();
    let score = 0;
    if (CHARGE_KW.test(quote)) score += 2;
    if (EXCLUDE_KW.test(quote)) score -= 3;
    if (!best || score > best.score) best = { amount: amt, score, quote };
  }
  return best && best.score > 0 ? { amount: best.amount, quote: best.quote } : null;
}
function selectChargeAmount(body: string): number | null {
  return pickChargeAmount(body)?.amount ?? null;
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
    // Representative price = the most recent grounded charge (not the first seen),
    // so a renewed price wins. Price change = the prior distinct price + when it moved.
    const dated = cs
      .filter((c): c is Charge & { amount: number } => c.amount !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const repAmount = dated.length ? dated[dated.length - 1].amount : null;
    let previousAmount: number | null = null;
    let priceChangedAt: string | null = null;
    if (repAmount !== null) {
      for (let i = dated.length - 2; i >= 0; i--) {
        if (Math.abs(dated[i].amount - repAmount) > 0.01) {
          previousAmount = dated[i].amount;
          priceChangedAt = dated[i + 1].date.toISOString();
          break;
        }
      }
    }
    const event: EventType =
      cs.map((c) => c.event).find((e) => e === "cancelled" || e === "payment_failed") ?? cs[0].event;
    const head = cs[0];
    const base = {
      serviceKey: service, serviceName: head.serviceName, serviceDomain: head.serviceDomain,
      amount: repAmount, previousAmount, priceChangedAt,
      currency: "USD", billingCycle: head.cycle, nextRenewal: head.nextRenewal,
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
