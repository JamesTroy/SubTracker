// Minimal shared-password gate for this single-user app. There is no user table —
// one APP_PASSWORD protects the dashboard and every data route. The session cookie
// holds a deterministic token derived from the password (no DB/session store), so
// both the login route (which sets it) and middleware (which verifies it) compute
// the same value. Uses Web Crypto only (globalThis.crypto), so it runs unchanged in
// Edge/Node middleware. When APP_PASSWORD is unset the gate is skipped (local dev).

export const SESSION_COOKIE = "subtracker_session";

export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode("subtracker.session.v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time hex compare so a present-but-wrong cookie can't be probed by timing.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
