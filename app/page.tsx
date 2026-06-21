import { supabaseAdmin } from "@/lib/supabase";
import { ScanButton, ReviewActions } from "./actions";
import { Hero, Section, Row, Empty, ReviewItem, type Sub } from "./ledger-ui";

export const dynamic = "force-dynamic";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3.6e6);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export default async function Page() {
  const db = supabaseAdmin();
  const [{ data: subs }, { data: review }, { data: scan }, { data: account }] = await Promise.all([
    db.from("subscriptions").select("*").order("amount_cents", { ascending: false, nullsFirst: false }),
    db.from("review_items").select("*").eq("status", "pending").order("created_at"),
    db.from("scan_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("gmail_accounts").select("email,last_scan_at").order("created_at", { ascending: true }).limit(1).maybeSingle(),
  ]);

  const all = (subs ?? []) as Sub[];
  const active = all.filter((s) => s.status === "active");
  const pastDue = all.filter((s) => s.status === "past_due");
  const ending = all.filter((s) => s.status === "ending");

  const totalCents = active.reduce((t, s) => t + (s.amount_cents ?? 0), 0);
  const priced = active.filter((s) => s.amount_cents !== null).length;
  const heldBack = scan?.n_rejected ?? 0;

  return (
    <main className="wrap">
      <div className="masthead">
        <div>
          <div className="eyebrow">build quiet · ship loud</div>
          <h1>SubTracker V1</h1>
        </div>
        <div className="scanbar">
          <span className="when">{account?.email ? `synced ${ago(account.last_scan_at)}` : "not connected"}</span>
          {scan?.error && <span className="when err" title={scan.error}>· last scan failed</span>}
          {account?.email ? <ScanButton /> : <a className="scan" href="/api/auth/google">Connect Gmail</a>}
        </div>
      </div>

      <Hero
        totalCents={totalCents}
        priced={priced}
        activeCount={active.length}
        heldBack={heldBack}
        showExport={all.length > 0}
      />

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
        <Section title="Needs a decision" count={review!.length} className="review">
          {review!.map((r) => (
            <ReviewItem key={r.id} serviceKey={r.service_key} reason={r.reason} actions={<ReviewActions id={r.id} />} />
          ))}
        </Section>
      )}

      <Section title="The rule" className="rule">
        <div className="kept-foot">
          <span className="k">A single email is a hypothesis, not a subscription.</span> Nothing reaches
          this ledger without an explicit recurring marker or repeat charges at a stable amount. When the
          guards can’t be sure, it asks — it never guesses.
        </div>
      </Section>
    </main>
  );
}
