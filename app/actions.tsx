"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ScanButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; reconnect?: boolean } | null>(null);
  const router = useRouter();
  async function scan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        // Surface the failure instead of silently doing nothing.
        setMsg({
          ok: false,
          reconnect: !!data?.reconnect,
          text: data?.error ? `scan failed — ${data.error}` : `scan failed (HTTP ${res.status})`,
        });
        return;
      }
      // A partial scan (failed emails or a truncated search) is NOT a clean success.
      const warn = data.failed > 0 || data.truncated;
      const parts = [`scanned ${data.scanned}`, `${data.new} new`, `${data.active} active`, `${data.review} to review`];
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      setMsg({
        ok: !warn,
        text: parts.join(" · ") + (data.truncated ? " — hit the 500 cap, older mail not yet scanned" : ""),
      });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: `scan failed — ${e instanceof Error ? e.message : "network error"}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="scanctl">
      <button className="scan" onClick={scan} disabled={busy}>
        {busy ? "scanning…" : "Scan inbox"}
      </button>
      {msg && (
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
