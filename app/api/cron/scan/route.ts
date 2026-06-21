import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/scan";

// GET /api/cron/scan — the scheduled scan. Wired to a daily cron in vercel.json.
// Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}` when the
// CRON_SECRET env var is set; we reject anything else so the endpoint can't be
// triggered by the public. (If CRON_SECRET is unset, the check is skipped —
// fine for local/dev, but set it in production.)
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const outcome = await runScan();
  if (outcome.ok) {
    console.log(
      `[cron/scan] ok — scanned ${outcome.scanned}, new ${outcome.new}, ` +
        `active ${outcome.active}, review ${outcome.review}, pdfResolved ${outcome.pdfResolved}`,
    );
  } else {
    console.error(`[cron/scan] failed (${outcome.status}): ${outcome.error}`);
  }
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : outcome.status });
}
