import Anthropic from "@anthropic-ai/sdk";
import { EmailMeta, Extraction } from "./types";

// Lazily constructed so importing this module (e.g. during `next build`'s route
// analysis) doesn't require ANTHROPIC_API_KEY — only an actual scan does.
// maxRetries: the SDK retries 429/5xx/overloaded with backoff, so a transient
// Anthropic hiccup mid-scan doesn't silently drop a subscription.
let _anthropic: Anthropic | null = null;
const anthropic = () => (_anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 }));

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
  const content =
    `From: ${email.fromName} <…@${email.fromDomain}>\n` +
    `Subject: ${email.subject}\n` +
    `Date: ${email.date}\n\n` +
    `${email.bodyText}`;
  const call = (maxTokens: number) =>
    anthropic().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_extraction" },
      messages: [{ role: "user", content }],
    });

  // 1500 fits the forced tool call comfortably; if a long receipt still truncates
  // the tool JSON (stop_reason "max_tokens"), retry once bigger rather than handing
  // guards a malformed object that becomes permanent review-queue noise.
  let res = await call(1500);
  if (res.stop_reason === "max_tokens") res = await call(3000);

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`No tool_use returned for message ${email.id}`);
  }
  // Returned as `unknown` on purpose — guards.ts validates it with Zod before
  // anything trusts it. A malformed shape is caught there, not here.
  return block.input as Extraction;
}
