import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// POST /api/review  { id, decision: 'confirmed' | 'rejected' }
// Resolves a review item AND records a durable service_override so the same
// pattern auto-resolves on every future scan — the learning loop.
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }
  const { id, decision } = (body ?? {}) as { id?: unknown; decision?: unknown };
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (decision !== "confirmed" && decision !== "rejected") {
    return NextResponse.json({ error: "decision must be confirmed or rejected" }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { data: item } = await db.from("review_items").select("*").eq("id", id).maybeSingle();
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Error-check every write so a failed resolution surfaces instead of a false ok:true
  // (a silently-dropped service_override would resurrect a service the user rejected).
  const { error: upErr } = await db.from("review_items").update({
    status: decision, resolved_service_key: item.service_key, resolved_at: new Date().toISOString(),
  }).eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  if (item.service_key) {
    const { error: ovErr } = await db.from("service_overrides").upsert({
      service_key: item.service_key,
      decision: decision === "confirmed" ? "subscription" : "not_subscription",
    }, { onConflict: "service_key" });
    if (ovErr) return NextResponse.json({ error: ovErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
