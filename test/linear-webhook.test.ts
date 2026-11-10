import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { isFreshWebhook, isOwnLinearEvent, signLinearState, verifyLinearSignature, verifyLinearState } from "@/lib/trackers/linear";
import { MAX_BODY_BYTES, receiveLinearWebhook } from "@/lib/trackers/linear-webhook";
import { TokenUnavailableError } from "@/lib/trackers/tokens";

const SECRET = "webhook-secret";
const NOW = 1_700_000_000_000;

function delivery(payload: unknown, secret = SECRET) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return { body, signature: createHmac("sha256", secret).update(body).digest("hex"), deliveryId: "d1", secret: SECRET, now: NOW };
}

const neverCalled = async () => {
  throw new Error("handled something it shouldn't have");
};

test("a good delivery is handled", async () => {
  let got: unknown;
  const receipt = await receiveLinearWebhook(delivery({ webhookTimestamp: NOW, type: "Issue" }), async (event) => {
    got = event;
    return { handled: true };
  });
  assert.equal(receipt.status, 200);
  assert.deepEqual(got, { deliveryId: "d1", payload: { webhookTimestamp: NOW, type: "Issue" } });
});

test("a bad signature is refused before the body is even parsed", async () => {
  const receipt = await receiveLinearWebhook(
    { body: new TextEncoder().encode("{not json"), signature: "ab".repeat(32), deliveryId: "d1", secret: SECRET, now: NOW },
    neverCalled,
  );
  assert.equal(receipt.status, 401);
});

test("a body changed after signing is refused", async () => {
  const good = delivery({ webhookTimestamp: NOW, title: "a" });
  const tampered = new TextEncoder().encode(JSON.stringify({ webhookTimestamp: NOW, title: "b" }));
  assert.equal((await receiveLinearWebhook({ ...good, body: tampered }, neverCalled)).status, 401);
});

test("a delivery signed with another secret is refused", async () => {
  assert.equal((await receiveLinearWebhook(delivery({ webhookTimestamp: NOW }, "other"), neverCalled)).status, 401);
});

test("the signature is over the raw bytes, not the body parsed and rewritten", async () => {
  const raw = new TextEncoder().encode(`{ "webhookTimestamp" : ${NOW},   "type":"Issue" }`);
  const signature = createHmac("sha256", SECRET).update(raw).digest("hex");
  const receipt = await receiveLinearWebhook({ body: raw, signature, deliveryId: "d1", secret: SECRET, now: NOW }, async () => ({ handled: true }));
  assert.equal(receipt.status, 200);
});

test("a missing or malformed signature is refused", () => {
  const body = new TextEncoder().encode("{}");
  assert.equal(verifyLinearSignature(body, null, SECRET), false);
  assert.equal(verifyLinearSignature(body, "not-hex", SECRET), false);
  assert.equal(verifyLinearSignature(body, createHmac("sha256", SECRET).update(body).digest("hex"), ""), false);
});

test("a stale delivery is refused, even signed, and said out loud with none of its contents", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(message);
  try {
    for (const webhookTimestamp of [NOW - 61_000, NOW + 61_000, undefined, "soon"]) {
      const receipt = await receiveLinearWebhook(delivery({ webhookTimestamp, title: "Secret title" }), neverCalled);
      assert.equal(receipt.status, 401);
    }
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, [
    "Linear: refused a signed webhook 61s old",
    "Linear: refused a signed webhook -61s old",
    "Linear: refused a signed webhook with no timestamp",
    "Linear: refused a signed webhook with no timestamp",
  ]);
  assert.equal(isFreshWebhook(NOW - 60_000, NOW), true);
});

test("an unsigned stale delivery says nothing: anyone could send those", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warned.push(message);
  try {
    await receiveLinearWebhook({ ...delivery({ webhookTimestamp: NOW - 61_000 }), signature: "ab".repeat(32) }, neverCalled);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, []);
});

test("with Linear not set up here, nothing is handled", async () => {
  const receipt = await receiveLinearWebhook({ ...delivery({ webhookTimestamp: NOW }), secret: null }, neverCalled);
  assert.equal(receipt.status, 404);
});

test("a body over the cap is refused before anything is done with it", async () => {
  const receipt = await receiveLinearWebhook(
    { body: new Uint8Array(MAX_BODY_BYTES + 1), signature: "ab".repeat(32), deliveryId: "d1", secret: SECRET, now: NOW },
    neverCalled,
  );
  assert.equal(receipt.status, 413);
});

test("the route refuses by Content-Length before reading the body", () => {
  const route = readFileSync(path.join(process.cwd(), "app/api/integrations/linear/webhook/route.ts"), "utf8");
  assert.ok(route.indexOf("content-length") < route.indexOf("request.arrayBuffer()"));
});

test("a failure answers non-200, so Linear delivers it again", async () => {
  const failed = await receiveLinearWebhook(delivery({ webhookTimestamp: NOW }), async () => {
    throw new Error("database down");
  });
  assert.equal(failed.status, 500);
  const noToken = await receiveLinearWebhook(delivery({ webhookTimestamp: NOW }), async () => {
    throw new TokenUnavailableError("wait");
  });
  assert.equal(noToken.status, 503);
});

test("our own events are recognised by the app user, on an issue or as a comment's author", () => {
  assert.equal(isOwnLinearEvent({ type: "Issue", actor: { id: "app" } }, "app"), true);
  assert.equal(isOwnLinearEvent({ type: "Comment", actor: null, data: { userId: "app" } }, "app"), true);
  assert.equal(isOwnLinearEvent({ type: "Issue", actor: { id: "ana" }, data: { userId: "app" } }, "app"), false);
  assert.equal(isOwnLinearEvent({ type: "Issue", actor: { id: "ana" } }, "app"), false);
  assert.equal(isOwnLinearEvent({ type: "Issue", actor: null }, null), false);
});

test("an OAuth state is ours, unexpired, and of the kind it says", () => {
  const state = { kind: "install" as const, ownerId: "u", orgId: "o", nonce: "n" };
  const token = signLinearState(state, "secret", NOW);
  assert.deepEqual(verifyLinearState(token, "secret", NOW), state);
  assert.equal(verifyLinearState(token, "other", NOW), null);
  assert.equal(verifyLinearState(token, "secret", NOW + 11 * 60 * 1000), null);
  assert.equal(verifyLinearState(`${token}x`, "secret", NOW), null);
  // An install has to name its org.
  assert.equal(verifyLinearState(signLinearState({ ...state, orgId: null }, "secret", NOW), "secret", NOW), null);
  assert.equal(verifyLinearState(signLinearState({ kind: "link", ownerId: "u", orgId: null, nonce: "n" }, "secret", NOW), "secret", NOW)?.kind, "link");
});
