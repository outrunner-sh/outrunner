/**
 * A webhook whose automation sends its runs to a Mission (docs/missions.md,
 * "Triggers"): the rules the route (app/api/automations/webhook) holds it to
 * beyond a session's.
 *
 *   key        a delivery key is required (`Idempotency-Key`, or
 *              `X-Delivery-Id`): a Mission's request is made once per key,
 *              and the same key with a different body is refused (409)
 *   signature  with a signing secret set, `X-Outrunner-Signature:
 *              sha256=<hex HMAC of the raw body>` must match (401 otherwise)
 *   nothing fetched  URLs in the payload are data for the Mission, never
 *              fetched here; nothing of the body, the key or the secret is
 *              logged
 *
 * No I/O, so the route and its tests share it.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { IDEMPOTENCY_KEY_MAX } from "@/lib/automations/webhook";

export type MissionWebhookCheck = { ok: true; key: string; payloadHash: string } | { ok: false; status: 400 | 401; error: string };

export function payloadHashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** The signature a body has under `secret`, as the header carries it. */
export function signatureOf(raw: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function sameSignature(given: string, wanted: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(wanted);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Check a Mission webhook's request: its key, and its signature when the
 *  automation has a secret. */
export function checkMissionWebhook(input: { headers: Headers; raw: string; secret: string | null }): MissionWebhookCheck {
  if (input.secret !== null) {
    const given = input.headers.get("x-outrunner-signature")?.trim() ?? "";
    if (!given || !sameSignature(given, signatureOf(input.raw, input.secret))) {
      return { ok: false, status: 401, error: "The X-Outrunner-Signature header doesn't match: sign the raw body with the webhook's secret (HMAC-SHA256, sha256=<hex>)." };
    }
  }
  const sent = input.headers.get("idempotency-key") ?? input.headers.get("x-delivery-id");
  const key = sent?.trim() ?? "";
  if (!key) {
    return { ok: false, status: 400, error: "A Mission's webhook needs a delivery key: send an Idempotency-Key (or X-Delivery-Id) header, the same on a retry." };
  }
  if (key.length > IDEMPOTENCY_KEY_MAX || /[\u0000-\u001f]/.test(key)) {
    return { ok: false, status: 400, error: `That delivery key isn't one: 1 to ${IDEMPOTENCY_KEY_MAX} characters.` };
  }
  return { ok: true, key: `webhook:key:${key}`, payloadHash: payloadHashOf(input.raw) };
}

/** A key seen before: the same body is the same request (answered as the
 *  first was); another body under it is a conflict. */
export function sameDelivery(earlier: readonly { payloadHash: string | null }[], payloadHash: string): boolean {
  return earlier.every((run) => run.payloadHash === null || run.payloadHash === payloadHash);
}
