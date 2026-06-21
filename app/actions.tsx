"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Progress = { phase: "search" } | { phase: "fetch"; done: number; total: number } | { phase: "persist" };

function ScanTracker({ p }: { p: Progress }) {
  const pct = p.phase === "fetch" && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
  const label =
    p.phase === "search" ? "finding candidates…"
      : p.phase === "persist" ? "saving…"
        : `reading ${p.done} / ${p.total} emails`;
  return (
    <span className="scantrack" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <span className="bar">
        <span className={`fill${pct === null ? " indet" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
      <span className="lbl">{label}{pct === null ? "" : ` · ${pct}%`}</span>
    </span>
  );
}

export function ScanButton() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; reconnect?: boolean } | null>(null);
  const router = useRouter();

  async function scan() {
    setBusy(true);
    setMsg(null);
    setProgress({ phase: "search" });
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      // Read the NDJSON progress stream; the final {type:"done"} carries the outcome.
      let outcome: Record<string, unknown> | null = null;
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let evt: { type?: string; outcome?: Record<string, unknown> } & Progress;
            try { evt = JSON.parse(line); } catch { continue; }
            if (evt.type === "progress") setProgress(evt as unknown as Progress);
            else if (evt.type === "done") outcome = evt.outcome ?? null;
          }
        }
      } else {
        outcome = await res.json().catch(() => null);
      }

      if (!outcome?.ok) {
        setMsg({
          ok: false,
          reconnect: !!outcome?.reconnect,
          text: outcome?.error ? `scan failed — ${outcome.error}` : "scan failed",
        });
        return;
      }
      // A partial scan (failed emails or a truncated search) is NOT a clean success.
      const o = outcome as { scanned: number; new: number; active: number; review: number; failed: number; truncated: boolean };
      const warn = o.failed > 0 || o.truncated;
      const parts = [`scanned ${o.scanned}`, `${o.new} new`, `${o.active} active`, `${o.review} to review`];
      if (o.failed > 0) parts.push(`${o.failed} failed`);
      setMsg({
        ok: !warn,
        text: parts.join(" · ") + (o.truncated ? " — hit the 500 cap, older mail not yet scanned" : ""),
      });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: `scan failed — ${e instanceof Error ? e.message : "network error"}` });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <span className="scanctl">
      <button className="scan" onClick={scan} disabled={busy}>
        {busy ? "scanning…" : "Scan inbox"}
      </button>
      {busy && progress && <ScanTracker p={progress} />}
      {!busy && msg && (
        <span className={`scanmsg${msg.ok ? "" : " err"}`} title={msg.text}>
          {msg.text}
          {msg.reconnect && <> · <a className="reconnect" href="/api/auth/google">reconnect</a></>}
        </span>
      )}
    </span>
  );
}

export function ReviewActions({ id }: { id: string }) {
  const [done, setDone] = useState<string | null>(null);
  const router = useRouter();
  async function resolve(decision: "confirmed" | "rejected") {
    setDone(decision);
    await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    router.refresh();
  }
  if (done) return <span className="why">{done === "confirmed" ? "kept" : "dismissed"}</span>;
  return (
    <div className="actions">
      <button className="act keep" onClick={() => resolve("confirmed")}>It’s a subscription</button>
      <button className="act" onClick={() => resolve("rejected")}>Not one</button>
    </div>
  );
}
