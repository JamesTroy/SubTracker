import {
  Hero, Section, Row, Empty, ReviewItem, DetailHero, EventRow,
  type Sub, type SubDetail, type Evidence,
} from "../ledger-ui";

// Static design showcase — renders every surface + state with mock data so the
// Aurora Glass UI can be reviewed/screenshotted without a database connection.
export const dynamic = "force-static";

const active: Sub[] = [
  { id: "1", service_name: "ChatGPT Plus", service_domain: "openai.com", amount_cents: 2000, previous_amount_cents: null, billing_cycle: "monthly", status: "active", next_renewal: "2026-07-02", evidence_count: 5 },
  { id: "2", service_name: "Rork", service_domain: "rork.com", amount_cents: 2000, previous_amount_cents: null, billing_cycle: "monthly", status: "active", next_renewal: null, evidence_count: 3 },
  { id: "3", service_name: "Vons FreshPass", service_domain: "vons.com", amount_cents: 1299, previous_amount_cents: null, billing_cycle: "monthly", status: "active", next_renewal: "2026-06-23", evidence_count: 4 },
  { id: "4", service_name: "Notion", service_domain: "notion.so", amount_cents: 1000, previous_amount_cents: 800, billing_cycle: "monthly", status: "active", next_renewal: "2026-07-10", evidence_count: 6 },
  { id: "5", service_name: "iCloud+", service_domain: "apple.com", amount_cents: 299, previous_amount_cents: null, billing_cycle: "monthly", status: "active", next_renewal: null, evidence_count: 9 },
  { id: "6", service_name: "Acme Pro (via Paddle)", service_domain: "acme.io", amount_cents: null, previous_amount_cents: null, billing_cycle: "monthly", status: "active", next_renewal: null, evidence_count: 2 },
];
const pastDue: Sub[] = [
  { id: "7", service_name: "Grammarly", service_domain: "grammarly.com", amount_cents: 1200, previous_amount_cents: null, billing_cycle: "monthly", status: "past_due", next_renewal: null, evidence_count: 2 },
];
const ending: Sub[] = [
  { id: "8", service_name: "Disney+", service_domain: "disneyplus.com", amount_cents: 1399, previous_amount_cents: null, billing_cycle: "monthly", status: "ending", next_renewal: null, evidence_count: 4 },
];
const review = [
  { id: "r1", service_key: "uber-eats-orders", reason: "6 one-time orders, varying amounts (CV 0.41)" },
  { id: "r2", service_key: "webroot", reason: "low confidence (0.45)" },
];

const detailSub: SubDetail = {
  id: "4", service_key: "notion", service_name: "Notion", service_domain: "notion.so",
  amount_cents: 1000, previous_amount_cents: 800, price_changed_at: "2026-06-10",
  currency: "USD", billing_cycle: "monthly", status: "active", next_renewal: "2026-07-10",
  evidence_count: 6, confidence: 0.93,
};
const history: Evidence[] = [
  { id: "e1", received_at: "2026-06-10", event_type: "charged", amount_cents: 1000, subject: "Your Notion receipt", from_name: "Notion", amount_quote: "Amount paid $10.00" },
  { id: "e2", received_at: "2026-05-10", event_type: "charged", amount_cents: 800, subject: "Your Notion receipt", from_name: "Notion", amount_quote: "Amount paid $8.00" },
  { id: "e3", received_at: "2026-04-10", event_type: "charged", amount_cents: 800, subject: "Your Notion receipt", from_name: "Notion", amount_quote: "Amount paid $8.00" },
  { id: "e4", received_at: "2026-03-10", event_type: "started", amount_cents: null, subject: "Welcome to Notion", from_name: "Notion", amount_quote: null },
];

const reviewActions = (
  <div className="actions">
    <button className="act keep">It’s a subscription</button>
    <button className="act">Not one</button>
  </div>
);

const divider = (label: string) => (
  <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--ink-faint)", margin: "64px 0 24px", borderTop: "1px solid var(--line)", paddingTop: 16 }}>
    {label}
  </div>
);

const totalCents = active.reduce((t, s) => t + (s.amount_cents ?? 0), 0);
const priced = active.filter((s) => s.amount_cents !== null).length;

export default function PreviewPage() {
  return (
    <main className="wrap">
      <div className="masthead">
        <div>
          <div className="eyebrow">build quiet · ship loud</div>
          <h1>SubTracker V1</h1>
        </div>
        <div className="scanbar">
          <span className="when">synced 2h ago</span>
          <button className="scan">Scan inbox</button>
        </div>
      </div>

      <Hero totalCents={totalCents} priced={priced} activeCount={active.length} heldBack={3} showExport />

      <Section title="Active" count={active.length}>
        {active.map((s) => <Row key={s.id} s={s} />)}
      </Section>

      <Section title="Past due" count={pastDue.length}>
        {pastDue.map((s) => <Row key={s.id} s={s} tag="due" />)}
      </Section>

      <Section title="Ending" count={ending.length}>
        {ending.map((s) => <Row key={s.id} s={s} tag="end" />)}
      </Section>

      <Section title="Needs a decision" count={review.length} className="review">
        {review.map((r) => (
          <ReviewItem key={r.id} serviceKey={r.service_key} reason={r.reason} actions={reviewActions} />
        ))}
      </Section>

      <Section title="The rule" className="rule">
        <div className="kept-foot">
          <span className="k">A single email is a hypothesis, not a subscription.</span> Nothing reaches
          this ledger without an explicit recurring marker or repeat charges at a stable amount. When the
          guards can’t be sure, it asks — it never guesses.
        </div>
      </Section>

      {divider("empty state")}
      <Section title="Active" count={0}>
        <Empty connected />
      </Section>

      {divider("detail view · /sub/[id]")}
      <DetailHero sub={detailSub} />
      <Section title="Payment history" count={history.length}>
        {history.map((h) => <EventRow key={h.id} e={h} />)}
      </Section>
    </main>
  );
}
