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

  // Notion raised its price: two receipts, $8 then $10. The newer price should
  // win (representative amount) and the older one is surfaced as the prior price.
  mk({ id: "notion-old", fromName: "Notion", fromDomain: "mail.notion.so", subject: "Your Notion receipt",
       date: "2026-04-10T09:00", bodyText: "Your Notion membership renewed. Amount paid $8.00." },
     { isSubscription: true, serviceName: "Notion", amount: { value: "$8.00", quote: "Amount paid $8.00" }, billingCycle: "monthly", eventType: "charged", hasRecurringMarker: true, confidence: 0.93 }),
  mk({ id: "notion-new", fromName: "Notion", fromDomain: "mail.notion.so", subject: "Your Notion receipt",
       date: "2026-06-10T09:00", bodyText: "Your Notion membership renewed. Amount paid $10.00." },
     { isSubscription: true, serviceName: "Notion", amount: { value: "$10.00", quote: "Amount paid $10.00" }, billingCycle: "monthly", eventType: "charged", hasRecurringMarker: true, confidence: 0.93 }),

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

  // marketing email that name-drops "Premium" — a recurring marker but no charge,
  // no lifecycle event, single email. Must go to review, NOT auto-confirm as active.
  mk({ id: "linkedin", fromName: "LinkedIn", fromDomain: "linkedin.com", subject: "1 person noticed you",
       bodyText: "Upgrade to LinkedIn Premium to see who viewed your profile." },
     { isSubscription: true, serviceName: "LinkedIn", billingCycle: "monthly", eventType: "none", hasRecurringMarker: true, confidence: 0.6 }),

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
  ["Notion price change $8 → $10 (newer wins)",
    (() => { const n = L.active.find((s) => s.serviceKey === "notion");
      return !!n && n.amount === 10 && n.previousAmount === 8 && n.priceChangedAt !== null; })()],
  ["Reddit stable price (no false price-change)",
    L.active.find((s) => s.serviceKey === "reddit-premium")?.previousAmount === null],
  ["LinkedIn marketing → review (marker but no charge/lifecycle)",
    L.review.some((r) => r.serviceKey === "linkedin") && !L.active.some((s) => s.serviceKey === "linkedin")],
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
