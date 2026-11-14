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
 *   Sentry and PagerDuty send their own headers, so a request carrying
 *   theirs is checked their way, with the same per-trigger secret (their
 *   Client Secret / subscription secret):
 *     Sentry     `Sentry-Hook-Signature`: hex HMAC-SHA256 of the raw body;
 *                its `Request-ID` is the key.
 *                https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
 *     PagerDuty  `X-PagerDuty-Signature`: `v1=<hex>`, several comma
 *                separated (a secret being rotated), any one may match;
 *                it sends no delivery id header, so the key is the body's
 *                `event.id` ("the unique id of the event").
 *                https://docs.pagerduty.com/developer/verifying-webhook-signatures
 *                https://docs.pagerduty.com/developer/webhooks-overview
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

export type WebhookProvider = "sentry" | "pagerduty" | "generic";

/** Who sent it, by the headers that are theirs. */
export function providerOf(headers: Headers): WebhookProvider {
  if (headers.has("sentry-hook-signature") || headers.has("sentry-hook-resource")) return "sentry";
  if (headers.has("x-pagerduty-signature")) return "pagerduty";
  return "generic";
}

const hexHmac = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");

/** PagerDuty's header value for a body: `v1=<hex>`. */
export function pagerDutySignatureOf(raw: string, secret: string): string {
  return `v1=${hexHmac(raw, secret)}`;
}

/** Whether any of the `v1=` signatures PagerDuty sent is the body's. */
function pagerDutySigned(header: string, raw: string, secret: string): boolean {
  const wanted = hexHmac(raw, secret);
  return header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => sameSignature(part.slice(3).toLowerCase(), wanted));
}

const KEY_OK = (key: string) => key.length > 0 && key.length <= IDEMPOTENCY_KEY_MAX && !/[\u0000-\u001f]/.test(key);

function providerCheck(provider: "sentry" | "pagerduty", input: { headers: Headers; raw: string; secret: string | null }): MissionWebhookCheck {
  const fail = (status: 400 | 401, error: string): MissionWebhookCheck => ({ ok: false, status, error });
  if (provider === "sentry") {
    if (input.secret !== null && !sameSignature((input.headers.get("sentry-hook-signature") ?? "").trim().toLowerCase(), hexHmac(input.raw, input.secret))) {
      return fail(401, "The Sentry-Hook-Signature header doesn't match: set this trigger's signing secret to the integration's Client Secret.");
    }
    const id = (input.headers.get("request-id") ?? "").trim();
    if (!KEY_OK(id)) return fail(400, "A Sentry delivery needs its Request-ID header.");
    return { ok: true, key: `webhook:sentry:${id}`, payloadHash: payloadHashOf(input.raw) };
  }
  if (input.secret !== null && !pagerDutySigned(input.headers.get("x-pagerduty-signature") ?? "", input.raw, input.secret)) {
    return fail(401, "The X-PagerDuty-Signature header doesn't match: set this trigger's signing secret to the webhook subscription's secret.");
  }
  let id = "";
  try {
    const event = (JSON.parse(input.raw) as { event?: { id?: unknown } } | null)?.event;
    id = typeof event?.id === "string" ? event.id.trim() : "";
  } catch {
    // Not JSON: no event id.
  }
  if (!KEY_OK(id)) return fail(400, "A PagerDuty delivery needs its event.id in the body.");
  return { ok: true, key: `webhook:pagerduty:${id}`, payloadHash: payloadHashOf(input.raw) };
}

/** Check a Mission webhook's request: its key, and its signature when the
 *  automation has a secret. */
export function checkMissionWebhook(input: { headers: Headers; raw: string; secret: string | null }): MissionWebhookCheck {
  const provider = providerOf(input.headers);
  if (provider !== "generic") return providerCheck(provider, input);
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
