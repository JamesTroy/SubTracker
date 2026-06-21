import Link from "next/link";
import { CountUp } from "./CountUp";

// Shared presentational pieces for the Ledger UI. Used by the live dashboard
// (page.tsx), the detail page (sub/[id]), and the /preview showcase so all three
// render byte-identical markup against the Aurora Glass system in globals.css.

export const money = (cents: number | null) =>
  cents === null ? null : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";

const EVENT_LABEL: Record<string, string> = {
  charged: "charged", upcoming: "upcoming", payment_failed: "payment failed",
  cancelled: "cancelled", started: "started", none: "—",
};

export type Sub = {
  id: string; service_name: string; service_domain: string | null;
  amount_cents: number | null; previous_amount_cents: number | null;
  billing_cycle: string; status: string; next_renewal: string | null; evidence_count: number;
};
export type SubDetail = Sub & {
  service_key: string; price_changed_at: string | null; currency: string | null; confidence: number | null;
};
export type Evidence = {
  id: string; received_at: string; event_type: string; amount_cents: number | null;
  subject: string | null; from_name: string | null; amount_quote: string | null;
};

// The one gradient-lit object on the page. "$" and cents stay solid; only the
// dollar integers are painted + animated.
export function Hero({ totalCents, priced, activeCount, heldBack, showExport }: {
  totalCents: number; priced: number; activeCount: number; heldBack: number; showExport: boolean;
}) {
  const [dollars, cents] = (money(totalCents) ?? "0.00").split(".");
  return (
    <section className="hero glass glass-strong">
      <div className="label">monthly, confirmed</div>
      <div className="total">
        <span className="sign">$</span>
        <CountUp value={Number(dollars.replace(/,/g, ""))} />
        <span className="cents">.{cents}</span>
      </div>
      <div className="sub">
        {priced} priced · {activeCount} active subscriptions
        {showExport && <> · <a className="export" href="/api/export">export csv</a></>}
      </div>
      {heldBack > 0 && (
        <div className="held">
          <b>{heldBack} emails held back</b> this scan — one-time orders, payment rails, and
          status notifications that look transactional but aren’t recurring.
        </div>
      )}
    </section>
  );
}

export function Section({ title, count, children, className }: {
  title: string; count?: number; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`section glass${className ? " " + className : ""}`}>
      <h2>{title}{count !== undefined && <span className="count">{count}</span>}</h2>
      {children}
    </section>
  );
}

export function Row({ s, tag }: { s: Sub; tag?: "due" | "end" }) {
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
          {prev !== null && <span className="tag chg">{up ? "↑" : "↓"} from ${prev}</span>}
        </div>
        <div className="meta">
          {s.billing_cycle}
          {s.evidence_count > 1 ? ` · ${s.evidence_count} receipts` : ""}
          {s.next_renewal ? ` · renews ${s.next_renewal}` : ""}
        </div>
      </div>
      <div className={`amt${amt === null ? " dim" : ""}`}>{amt === null ? "needs PDF" : `$${amt}`}</div>
    </Link>
  );
}

export function ReviewItem({ serviceKey, reason, actions }: {
  serviceKey: string | null; reason: string; actions: React.ReactNode;
}) {
  return (
    <div className="row">
      <div>
        <div className="name">{serviceKey ?? "Unknown charge"}</div>
        <div className="why">{reason}</div>
      </div>
      {actions}
    </div>
  );
}

export function Empty({ connected }: { connected: boolean }) {
  return (
    <div className="empty">
      {connected
        ? "No confirmed subscriptions yet — run a scan to read your inbox."
        : "Connect Gmail to find your subscriptions."}
    </div>
  );
}

export function DetailHero({ sub }: { sub: SubDetail }) {
  const amt = money(sub.amount_cents);
  const [d, c] = (amt ?? "0.00").split(".");
  const prev = money(sub.previous_amount_cents);
  const up =
    sub.previous_amount_cents !== null && sub.amount_cents !== null && sub.amount_cents > sub.previous_amount_cents;
  return (
    <section className="hero detail glass glass-strong">
      <div className="label">{sub.status}{sub.service_domain ? ` · ${sub.service_domain}` : ""}</div>
      <div className="detail-name">{sub.service_name}</div>
      <div className="total">
        {amt === null ? (
          <span className="dim">needs PDF</span>
        ) : (
          <><span className="sign">$</span><span className="dollars">{d}</span><span className="cents">.{c}</span></>
        )}
        <span className="per">/ {sub.billing_cycle}</span>
      </div>
      {prev !== null && (
        <div className="pricenote">
          {up ? "↑" : "↓"} was ${prev}{sub.price_changed_at ? ` until ${day(sub.price_changed_at)}` : ""}
        </div>
      )}
      <div className="sub">
        {sub.evidence_count} {sub.evidence_count === 1 ? "receipt" : "receipts"}
        {sub.next_renewal ? ` · renews ${sub.next_renewal}` : ""}
        {sub.confidence !== null ? ` · confidence ${sub.confidence}` : ""}
      </div>
    </section>
  );
}

export function EventRow({ e }: { e: Evidence }) {
  const ha = money(e.amount_cents);
  return (
    <div className="row event">
      <div>
        <div className="name">
          {e.subject ?? e.from_name ?? "—"}
          <span className={`tag ${e.event_type === "payment_failed" ? "due" : "end"}`}>
            {EVENT_LABEL[e.event_type] ?? e.event_type}
          </span>
        </div>
        <div className="meta">
          {day(e.received_at)}
          {e.amount_quote ? ` · ${e.amount_quote}` : ""}
        </div>
      </div>
      <div className={`amt${ha === null ? " dim" : ""}`}>{ha === null ? "—" : `$${ha}`}</div>
    </div>
  );
}
