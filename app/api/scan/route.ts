import { runScan } from "@/lib/scan";

// POST /api/scan — manual scan from the dashboard. Streams NDJSON:
//   {"type":"progress","phase":"fetch","done":120,"total":500}\n   (while scanning)
//   {"type":"done","outcome":{...}}\n                              (final result)
// so the Scan button can show a live tracker. The cron route calls runScan()
// directly (no streaming). The full pipeline lives in lib/scan.ts.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* client gone */ }
      };
      try {
        const outcome = await runScan((p) => send({ type: "progress", ...p }));
        send({ type: "done", outcome });
      } catch (e) {
        send({ type: "done", outcome: { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
