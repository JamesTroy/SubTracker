import { notFound } from "next/navigation";
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { DetailHero, Section, EventRow, type SubDetail, type Evidence } from "../../ledger-ui";

export const dynamic = "force-dynamic";

export default async function SubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: sub } = await db.from("subscriptions").select("*").eq("id", id).maybeSingle();
  if (!sub) notFound();
  const s = sub as SubDetail;

  // Link by subscription_id ONLY. The old service_key arm both allowed a raw
  // interpolated value into the PostgREST filter and surfaced rejected-group
  // evidence (which keeps its service_key but has no subscription_id) as history.
  const { data: ev } = await db
    .from("charge_evidence")
    .select("id, received_at, event_type, amount_cents, subject, from_name, amount_quote")
    .eq("subscription_id", id)
    .order("received_at", { ascending: false });
  const history = (ev ?? []) as Evidence[];

  return (
    <main className="wrap">
      <div className="masthead">
        <div>
          <div className="eyebrow">build quiet · ship loud</div>
          <h1>SubTracker V1</h1>
        </div>
        <Link className="back" href="/">← all subscriptions</Link>
      </div>

      <DetailHero sub={s} />

      <Section title="Payment history" count={history.length}>
        {history.length === 0
          ? <div className="empty">No evidence rows recorded yet.</div>
          : history.map((h) => <EventRow key={h.id} e={h} />)}
      </Section>
    </main>
  );
}
