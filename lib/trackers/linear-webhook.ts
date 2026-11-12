/**
 * Receiving a Linear webhook, in the order that keeps it safe: the signature
 * over the raw bytes before anything else (nothing unsigned is even parsed),
 * then the timestamp, so a captured delivery can't be replayed, and only then
 * the event. A failure answers non-200, which is what makes Linear deliver it
 * again; anything else is answered 200, since a retry wouldn't change it.
 */

import { isFreshWebhook, verifyLinearSignature } from "@/lib/trackers/linear";
import { TokenUnavailableError } from "@/lib/trackers/tokens";

/** A body Linear sends is far below this; anything bigger isn't Linear's. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type LinearReceipt = { status: 200 | 400 | 401 | 404 | 413 | 500 | 503; body: Record<string, unknown> };

export type LinearWebhookInput = {
  body: Uint8Array;
  signature: string | null;
  deliveryId: string | null;
  /** The app's webhook signing secret; null when Linear isn't set up here. */
  secret: string | null;
  now?: number;
};

export async function receiveLinearWebhook(
  input: LinearWebhookInput,
  handle: (event: { deliveryId: string | null; payload: unknown }) => Promise<{ handled: boolean; reason?: string }>,
): Promise<LinearReceipt> {
  if (!input.secret) return { status: 404, body: { error: "Linear isn't set up here." } };
  // A body with no Content-Length (chunked) is measured once read.
  if (input.body.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!verifyLinearSignature(input.body, input.signature, input.secret)) return { status: 401, body: { error: "Bad signature." } };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(input.body).toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Not JSON." } };
  }
  const timestamp = (payload as { webhookTimestamp?: unknown } | null)?.webhookTimestamp;
  if (!isFreshWebhook(timestamp, input.now)) {
    // Signed, so it's Linear's. If its retries keep their first timestamp, every
    // retry lands here, and redelivery would quietly do nothing: this says so.
    const age = typeof timestamp === "number" ? `${Math.round(((input.now ?? Date.now()) - timestamp) / 1000)}s old` : "with no timestamp";
    console.warn(`Linear: refused a signed webhook ${age}`);
    return { status: 401, body: { error: "Stale webhook." } };
  }

  try {
    const result = await handle({ deliveryId: input.deliveryId, payload });
    return { status: 200, body: result };
  } catch (error) {
    // Someone else's refresh is taking too long: Linear can try again soon.
    if (error instanceof TokenUnavailableError) return { status: 503, body: { error: "Try again." } };
    console.error("Linear webhook failed", error);
    return { status: 500, body: { error: "Failed." } };
  }
}
