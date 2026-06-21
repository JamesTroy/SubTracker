"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Single shared-password login. Posts to /api/auth/login, which sets the session
// cookie; middleware then lets the dashboard through. `next` is read from the URL in
// the handler (no useSearchParams, so the page needs no Suspense boundary).
export default function LoginPage() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get("next") || "/";
        router.replace(next.startsWith("/") ? next : "/");
        router.refresh();
      } else {
        setErr((await res.json().catch(() => ({})))?.error ?? "login failed");
        setBusy(false);
      }
    } catch {
      setErr("network error");
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <div className="login-card glass">
        <div className="eyebrow">build quiet · ship loud</div>
        <h1 className="login-title">SubTracker V1</h1>
        <p className="login-sub">Enter the access password to view your ledger.</p>
        <form onSubmit={submit} className="login-form">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Password"
            autoFocus
            className="login-input"
            aria-label="Access password"
          />
          <button type="submit" className="scan" disabled={busy || !pw}>
            {busy ? "checking…" : "Unlock"}
          </button>
        </form>
        {err && <div className="login-err">{err}</div>}
      </div>
    </main>
  );
}
