import { notFound } from "next/navigation";
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const money = (cents: number | null) =>
  cents === null ? null : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";

const EVENT_LABEL: Record<string, string> = {
  charged: "charged", upcoming: "upcoming", payment_failed: "payment failed",
  cancelled: "cancelled", started: "started", none: "—",
};

type Sub = {
  id: string; service_key: string; service_name: string; service_domain: string | null;
  amount_cents: number | null; previous_amount_cents: number | null; price_changed_at: string | null;
  currency: string | null; billing_cycle: string; status: string; next_renewal: string | null;
  evidence_count: number; confidence: number | null;
};

type Evidence = {
  id: string; received_at: string; event_type: string; amount_cents: number | null;
  subject: string | null; from_name: string | null; amount_quote: string | null;
};

export default async function SubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: sub } = await db.from("subscriptions").select("*").eq("id", id).maybeSingle();
  if (!sub) notFound();
  const s = sub as Sub;

  const { data: ev } = await db
    .from("charge_evidence")
    .select("id, received_at, event_type, amount_cents, subject, from_name, amount_quote")
    .or(`subscription_id.eq.${id},service_key.eq.${s.service_key}`)
    .order("received_at", { ascending: false });
  const history = (ev ?? []) as Evidence[];

  const amt = money(s.amount_cents);
  const prev = money(s.previous_amount_cents);
  const up = s.previous_amount_cents !== null && s.amount_cents !== null && s.amount_cents > s.previous_amount_cents;

  return (
    <main className="wrap">
      <div className="masthead">
        <div>
          <div className="eyebrow">build quiet · ship loud</div>
          <h1>Ledger</h1>
        </div>
        <Link className="back" href="/">← all subscriptions</Link>
      </div>

      <section className="hero detail">
        <div className="label">{s.status}{s.service_domain ? ` · ${s.service_domain}` : ""}</div>
        <div className="detail-name">{s.service_name}</div>
        <div className="total">
          {amt === null ? <span className="dim">needs PDF</span> : <>${amt}</>}
          <span className="per"> / {s.billing_cycle}</span>
        </div>
        {prev !== null && (
          <div className="pricenote">
            {up ? "↑" : "↓"} was ${prev}{s.price_changed_at ? ` until ${day(s.price_changed_at)}` : ""}
          </div>
        )}
        <div className="sub">
          {s.evidence_count} {s.evidence_count === 1 ? "receipt" : "receipts"}
          {s.next_renewal ? ` · renews ${s.next_renewal}` : ""}
          {s.confidence !== null ? ` · confidence ${s.confidence}` : ""}
        </div>
      </section>

      <section className="section">
        <h2>Payment history <span className="count">{history.length}</span></h2>
        {history.length === 0 ? (
          <div className="empty">No evidence rows recorded yet.</div>
        ) : (
          history.map((h) => {
            const ha = money(h.amount_cents);
            return (
              <div className="row event" key={h.id}>
                <div>
                  <div className="name">
                    {h.subject ?? h.from_name ?? "—"}
                    <span className={`tag ${h.event_type === "payment_failed" ? "due" : "end"}`}>
                      {EVENT_LABEL[h.event_type] ?? h.event_type}
                    </span>
                  </div>
                  <div className="meta">
                    {day(h.received_at)}
                    {h.amount_quote ? ` · ${h.amount_quote}` : ""}
                  </div>
                </div>
                <div className={`amt${ha === null ? " dim" : ""}`}>{ha === null ? "—" : `$${ha}`}</div>
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
