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
  status: "active" | "past_due" | "ending" | "candidate" | "pending";
  amount: number | null;       // dollars; the most recent grounded charge (null = unknown price)
  previousAmount: number | null; // the prior distinct price, if it changed over time
  priceChangedAt: string | null; // ISO date the price moved to `amount`
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
  pending: SubResult[];        // strict mode: confirmable but not yet user-approved
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
