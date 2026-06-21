import { EmailMeta } from "./types";

// Minimal Gmail API client. Read-only; never mutates the mailbox.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Exchange a refresh token for a short-lived access token.
export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // invalid_grant here usually means the consent screen is still in "Testing"
    // (7-day token expiry) or the user revoked access — prompt a reconnect.
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }
  return (await res.json()).access_token as string;
}

// List message ids matching a Gmail search query, paging up to `cap`.
export async function searchMessageIds(
  accessToken: string,
  query: string,
  cap = 500,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`messages.list failed (${res.status})`);
    const data = await res.json();
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < cap);
  return ids.slice(0, cap);
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
  filename?: string;
}

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Walk the MIME tree, preferring text/plain, falling back to stripped text/html.
// Also records the first PDF attachment's id so the amount can be read from it
// when the email body carries no price (lib/pdf.ts).
function extractBody(payload: GmailPart): { text: string; hasPdf: boolean; pdfAttachmentId?: string } {
  let plain = "";
  let html = "";
  let hasPdf = false;
  let pdfAttachmentId: string | undefined;
  const walk = (p: GmailPart) => {
    if (p.filename && /\.pdf$/i.test(p.filename)) {
      hasPdf = true;
      if (!pdfAttachmentId && p.body?.attachmentId) pdfAttachmentId = p.body.attachmentId;
    }
    if (p.mimeType === "text/plain" && p.body?.data) plain += b64urlDecode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) html += b64urlDecode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const text = plain.trim()
    ? plain
    : html.replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;|&zwnj;|\u034f/g, " ")
          .replace(/\s+/g, " ");
  return { text: text.trim(), hasPdf, pdfAttachmentId };
}

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(raw: string): { name: string; domain: string } {
  const m = raw.match(/^(.*?)<([^>]+)>$/);
  const name = (m ? m[1] : raw).replace(/"/g, "").trim();
  const email = (m ? m[2] : raw).trim();
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return { name: name || email, domain };
}

// Fetch one message and flatten it into EmailMeta (+ a hasPdf hint for the
// rare body-less Paddle receipts where the amount lives only in the PDF).
export async function getMessage(
  accessToken: string,
  id: string,
): Promise<EmailMeta & { hasPdf: boolean; pdfAttachmentId?: string }> {
  const res = await fetch(`${API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`messages.get failed (${res.status}) for ${id}`);
  const msg = await res.json();
  const headers = msg.payload?.headers ?? [];
  const { name, domain } = parseFrom(header(headers, "From"));
  const { text, hasPdf, pdfAttachmentId } = extractBody(msg.payload ?? {});
  return {
    id,
    fromName: name,
    fromDomain: domain,
    subject: header(headers, "Subject"),
    date: new Date(Number(msg.internalDate)).toISOString(),
    bodyText: text.slice(0, 6000), // cap tokens sent to the extractor
    hasPdf,
    pdfAttachmentId,
  };
}

// Fetch a single attachment's bytes (read-only). Gmail returns base64url data.
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await fetch(`${API}/messages/${messageId}/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`attachments.get failed (${res.status}) for ${messageId}`);
  const data = await res.json();
  return Buffer.from(String(data.data).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// The candidate net. category:purchases is the strongest single filter; the OR
// terms catch lifecycle emails (dunning, cancellations) Gmail files elsewhere.
export const CANDIDATE_QUERY =
  'newer_than:1y (category:purchases OR subscription OR renew OR membership OR "payment failed" OR "auto-renew")';
