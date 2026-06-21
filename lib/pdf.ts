import { extractText, getDocumentProxy } from "unpdf";
import { getAttachment } from "./gmail";
import { pickChargeAmount } from "./guards";

// PDF amount fallback. A few processors (notably Paddle) send a body-less
// receipt where the price lives only in an attached PDF — those subs surface as
// "needs PDF". This reads the PDF text and applies the same charge-context
// selector the guards use on email bodies, so the same decoy rules apply.
//
// Deliberately best-effort: any failure (fetch, parse, no charge-context amount)
// returns null and the subscription stays "needs PDF" — never a guessed price.
export async function extractPdfAmount(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<{ amount: number; quote: string } | null> {
  const buf = await getAttachment(accessToken, messageId, attachmentId);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const flat = Array.isArray(text) ? text.join(" ") : text;
  const picked = pickChargeAmount(flat);
  if (!picked) return null;
  return { amount: picked.amount, quote: `PDF: ${picked.quote}` };
}
