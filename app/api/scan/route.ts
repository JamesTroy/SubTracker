import { NextResponse } from "next/server";
import { runScan } from "@/lib/scan";

// POST /api/scan — manual scan triggered from the dashboard.
// The full pipeline lives in lib/scan.ts so the cron route can share it.
export const maxDuration = 300;

export async function POST() {
  const outcome = await runScan();
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : outcome.status });
}
