import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/approve { serviceKey, decision: 'approve' | 'dismiss' }
// One-tap promotion of a pending subscription. Writes the durable override (the
// learning loop, so it's never asked again) and updates the ledger immediately:
//   approve  → service_overrides 'subscription' + status active
//   dismiss  → service_overrides 'not_subscription' + remove the row (the override
//              keeps it out of every future scan)
export async function POST(req: NextRequest) {
  let body: { serviceKey?: unknown; decision?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const { serviceKey, decision } = body;
  if (typeof serviceKey !== "string" || !serviceKey) {
    return NextResponse.json({ error: "serviceKey required" }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "dismiss") {
    return NextResponse.json({ error: "decision must be approve or dismiss" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { error: ovErr } = await db.from("service_overrides").upsert(
    { service_key: serviceKey, decision: decision === "approve" ? "subscription" : "not_subscription" },
    { onConflict: "service_key" },
  );
  if (ovErr) return NextResponse.json({ error: ovErr.message }, { status: 500 });

  if (decision === "approve") {
    const { error } = await db.from("subscriptions").update({ status: "active" }).eq("service_key", serviceKey);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await db.from("subscriptions").delete().eq("service_key", serviceKey);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
