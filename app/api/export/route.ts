import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Row = {
  service_name: string;
  service_key: string;
  status: string;
  amount_cents: number | null;
  previous_amount_cents: number | null;
  currency: string | null;
  billing_cycle: string;
  next_renewal: string | null;
  price_changed_at: string | null;
  evidence_count: number;
  confidence: number | null;
  service_domain: string | null;
};

const dollars = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

// CSV-escape: wrap in quotes and double any embedded quotes when needed.
const cell = (v: string | number | null) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/export — download the full ledger as a CSV.
export async function GET() {
  const db = supabaseAdmin();
  const { data } = await db
    .from("subscriptions")
    .select("*")
    .order("status")
    .order("amount_cents", { ascending: false, nullsFirst: false });

  const rows = (data ?? []) as Row[];
  const header = [
    "service", "service_key", "status", "amount", "previous_amount", "currency",
    "billing_cycle", "next_renewal", "price_changed_at", "evidence_count",
    "confidence", "domain",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      cell(r.service_name), cell(r.service_key), cell(r.status),
      cell(dollars(r.amount_cents)), cell(dollars(r.previous_amount_cents)), cell(r.currency ?? "USD"),
      cell(r.billing_cycle), cell(r.next_renewal), cell(r.price_changed_at),
      cell(r.evidence_count), cell(r.confidence), cell(r.service_domain),
    ].join(","));
  }
  const csv = lines.join("\n") + "\n";

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ledger.csv"',
      "Cache-Control": "no-store",
    },
  });
}
