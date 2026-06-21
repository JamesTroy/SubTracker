import Link from "next/link";
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
  previous_amount_cents: number | null; billing_cycle: string; status: string;
  next_renewal: string | null; evidence_count: number;
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
        <div className="sub">
          {priced} priced · {active.length} active subscriptions
          {all.length > 0 && <> · <a className="export" href="/api/export">export csv</a></>}
        </div>
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
  const prev = money(s.previous_amount_cents);
  const up =
    s.previous_amount_cents !== null && s.amount_cents !== null && s.amount_cents > s.previous_amount_cents;
  return (
    <Link className="row rowlink" href={`/sub/${s.id}`}>
      <div>
        <div className="name">
          {s.service_name}
          {tag === "due" && <span className="tag due">payment failed</span>}
          {tag === "end" && <span className="tag end">won’t renew</span>}
          {prev !== null && (
            <span className="tag chg" title={`was $${prev}`}>{up ? "↑" : "↓"} from ${prev}</span>
          )}
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
    </Link>
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
