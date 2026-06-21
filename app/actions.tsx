"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function scan() {
    setBusy(true);
    try {
      await fetch("/api/scan", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="scan" onClick={scan} disabled={busy}>
      {busy ? "scanning…" : "Scan inbox"}
    </button>
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
