/**
 * Sentry's and PagerDuty's own webhooks into a Mission's trigger
 * (lib/missions/webhook-target.ts). Each sample body is the one in the
 * provider's docs, recorded in test/fixtures (Sentry's issue webhook:
 * docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/;
 * PagerDuty's incident.priority_updated, the one incident sample its docs
 * give: docs.pagerduty.com/developer/webhooks-overview). The signatures are
 * computed here as the docs say, with a made-up secret.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkMissionWebhook, pagerDutySignatureOf, payloadHashOf, providerOf, signatureOf } from "@/lib/missions/webhook-target";

const sentryBody = readFileSync("test/fixtures/sentry-issue-created.json", "utf8");
const pagerBody = readFileSync("test/fixtures/pagerduty-incident-priority-updated.json", "utf8");
const secret = "not-a-real-secret-0123456789abcdef";
const hex = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");

const sentryHeaders = (patch: Record<string, string> = {}) =>
  new Headers({ "content-type": "application/json", "request-id": "b1946ac9-2f3c-4a39-9cd1-0e5f1d3b7c11", "sentry-hook-resource": "issue", "sentry-hook-timestamp": "1731272160", "sentry-hook-signature": hex(sentryBody), ...patch });
const pagerHeaders = (signature: string) => new Headers({ "content-type": "application/json", "x-pagerduty-signature": signature });

test("Sentry: its signature (a hex HMAC of the raw body) is the check and the signed body is the key, whatever Request-ID says", () => {
  const ok = checkMissionWebhook({ headers: sentryHeaders(), raw: sentryBody, secret });
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.key, `webhook:sentry:${payloadHashOf(sentryBody)}`);
  assert.equal(providerOf(sentryHeaders()), "sentry");
  // The same delivery again: the same key, so the route answers it as the first.
  const again = checkMissionWebhook({ headers: sentryHeaders(), raw: sentryBody, secret });
  assert.equal(again.ok && again.key, ok.ok && ok.key);
  // The body changed, or another secret signed it, or no signature: refused.
  assert.deepEqual(checkMissionWebhook({ headers: sentryHeaders(), raw: sentryBody.replace("fatal", "info"), secret }), {
    ok: false,
    status: 401,
    error: "The Sentry-Hook-Signature header doesn't match: set this trigger's signing secret to the integration's Client Secret.",
  });
  assert.equal(checkMissionWebhook({ headers: sentryHeaders({ "sentry-hook-signature": hex(sentryBody, "other") }), raw: sentryBody, secret }).ok, false);
  const unsigned = sentryHeaders();
  unsigned.delete("sentry-hook-signature");
  assert.equal(checkMissionWebhook({ headers: unsigned, raw: sentryBody, secret }).ok, false);
  // Re-serialised JSON is another body: the docs say to sign the raw bytes.
  assert.equal(checkMissionWebhook({ headers: sentryHeaders(), raw: JSON.stringify(JSON.parse(sentryBody), null, 1), secret }).ok, false);
  // Request-ID isn't signed: a replay under another one is the same delivery.
  const replay = checkMissionWebhook({ headers: sentryHeaders({ "request-id": "a-fresh-id-from-the-replayer" }), raw: sentryBody, secret });
  assert.equal(replay.ok && replay.key, ok.ok && ok.key);
  // None is fine when it's signed.
  const noId = sentryHeaders();
  noId.delete("request-id");
  const without = checkMissionWebhook({ headers: noId, raw: sentryBody, secret });
  assert.equal(without.ok && without.key, ok.ok && ok.key);
  // A body that differs by a byte (re-signed) is another delivery.
  const changed = sentryBody.replace('"count":"3"', '"count":"4"');
  const another = checkMissionWebhook({ headers: sentryHeaders({ "sentry-hook-signature": hex(changed) }), raw: changed, secret });
  assert.ok(another.ok);
  assert.notEqual(another.ok && another.key, ok.ok && ok.key);
});

test("PagerDuty: v1= signatures (several, comma separated) and the body's event.id are the check and the key", () => {
  const good = pagerDutySignatureOf(pagerBody, secret);
  const stale = `v1=${hex(pagerBody, "the-old-secret")}`;
  for (const header of [good, `${stale},${good}`, `${good}, ${stale}`, `v0=abc,${good}`]) {
    const ok = checkMissionWebhook({ headers: pagerHeaders(header), raw: pagerBody, secret });
    assert.ok(ok.ok, header);
    assert.equal(ok.ok && ok.key, "webhook:pagerduty:5ac64822-4adc-4fda-ade0-410becf0de4f");
  }
  assert.equal(providerOf(pagerHeaders(good)), "pagerduty");
  for (const header of [stale, "", "v1=", `v2=${hex(pagerBody)}`, hex(pagerBody)]) {
    const bad = checkMissionWebhook({ headers: pagerHeaders(header), raw: pagerBody, secret });
    assert.equal(bad.ok, false, header);
    assert.equal(!bad.ok && bad.status, 401);
  }
  // Signed, but with no event.id (or not JSON): no key.
  const noId = JSON.stringify({ event: {} });
  const refused = checkMissionWebhook({ headers: pagerHeaders(pagerDutySignatureOf(noId, secret)), raw: noId, secret });
  assert.equal(!refused.ok && refused.status, 400);
  assert.equal(checkMissionWebhook({ headers: pagerHeaders(pagerDutySignatureOf("nope", secret)), raw: "nope", secret }).ok, false);
});

test("a trigger's secret is the only gate: a provider's headers can't skip a signature, and the generic way is unchanged", () => {
  // A trigger with a secret never takes a request that signs nothing, whatever it claims to be.
  assert.equal(checkMissionWebhook({ headers: new Headers({ "idempotency-key": "k1" }), raw: sentryBody, secret }).ok, false);
  assert.equal(checkMissionWebhook({ headers: new Headers({ "sentry-hook-resource": "issue", "request-id": "r1" }), raw: sentryBody, secret }).ok, false);
  assert.equal(checkMissionWebhook({ headers: new Headers({ "x-outrunner-signature": signatureOf(sentryBody, secret) }), raw: sentryBody, secret }).ok, false, "no key");
  // A generic caller's signature isn't taken for a provider's, nor the reverse.
  const generic = new Headers({ "x-outrunner-signature": signatureOf(sentryBody, secret), "idempotency-key": "k1" });
  const ok = checkMissionWebhook({ headers: generic, raw: sentryBody, secret });
  assert.equal(ok.ok && ok.key, "webhook:key:k1");
  assert.equal(providerOf(generic), "generic");
  // With no secret, as before: a key is all that's asked (here the provider's).
  assert.ok(checkMissionWebhook({ headers: sentryHeaders({ "sentry-hook-signature": "" }), raw: sentryBody, secret: null }).ok);
  assert.equal(checkMissionWebhook({ headers: new Headers(), raw: sentryBody, secret: null }).ok, false);
});
