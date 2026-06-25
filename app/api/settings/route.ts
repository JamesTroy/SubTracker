import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { setStrictMode } from "@/lib/settings";

export const dynamic = "force-dynamic";

// POST /api/settings { strict: boolean } — toggle strict mode.
// Enabling also reconciles the EXISTING ledger so the guarantee is retroactive:
// any active/past_due/ending sub without a 'subscription' approval moves to
// 'pending' (one-tap Approve to keep it). Disabling restores pending → active
// (the next scan recomputes the precise status).
export async function POST(req: NextRequest) {
  let body: { strict?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }
  if (typeof body.strict !== "boolean") {
    return NextResponse.json({ error: "strict (boolean) required" }, { status: 400 });
  }
  const on = body.strict;

  const set = await setStrictMode(on);
  if (!set.ok) return NextResponse.json({ error: set.error }, { status: 500 });

  const db = supabaseAdmin();

  if (on) {
    const { data: approved, error: aErr } = await db
      .from("service_overrides").select("service_key").eq("decision", "subscription");
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });
    const approvedKeys = new Set((approved ?? []).map((r) => r.service_key));

    const { data: live, error: lErr } = await db
      .from("subscriptions").select("id, service_key").in("status", ["active", "past_due", "ending"]);
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

    const toPend = (live ?? []).filter((s) => !approvedKeys.has(s.service_key)).map((s) => s.id);
    if (toPend.length) {
      const { error } = await db.from("subscriptions").update({ status: "pending" }).in("id", toPend);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, strict: true, movedToPending: toPend.length });
  }

  const { error } = await db.from("subscriptions").update({ status: "active" }).eq("status", "pending");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, strict: false });
}
