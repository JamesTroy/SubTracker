import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// POST /api/review  { id, decision: 'confirmed' | 'rejected' }
// Resolves a review item AND records a durable service_override so the same
// pattern auto-resolves on every future scan — the learning loop.
export async function POST(req: NextRequest) {
  const { id, decision } = await req.json();
  if (!["confirmed", "rejected"].includes(decision)) {
    return NextResponse.json({ error: "decision must be confirmed or rejected" }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { data: item } = await db.from("review_items").select("*").eq("id", id).single();
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.from("review_items").update({
    status: decision, resolved_service_key: item.service_key, resolved_at: new Date().toISOString(),
  }).eq("id", id);

  if (item.service_key) {
    await db.from("service_overrides").upsert({
      service_key: item.service_key,
      decision: decision === "confirmed" ? "subscription" : "not_subscription",
    }, { onConflict: "service_key" });
  }

  return NextResponse.json({ ok: true });
}
