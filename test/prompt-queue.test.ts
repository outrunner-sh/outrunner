import assert from "node:assert/strict";
import { test } from "node:test";

import { queueDrains, readQueue, writeQueue, type QueueStorage } from "@/lib/session/prompt-queue";

function memory(): QueueStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

test("a session's queue is kept for the tab, in order, and forgotten once empty", () => {
  const storage = memory();
  const queue = [
    { id: "a", text: "whats next?", attachmentIds: [] },
    { id: "b", text: "", attachmentIds: ["f1"] },
  ];
  writeQueue(storage, "w1", queue);
  assert.deepEqual(readQueue(storage, "w1"), queue);
  // Another session's is its own.
  assert.deepEqual(readQueue(storage, "w2"), []);
  writeQueue(storage, "w1", []);
  assert.equal(storage.items.size, 0);
});

test("a kept queue that can't be read sends nothing it can't vouch for", () => {
  const storage = memory();
  storage.setItem("outrunner:queue:w1", "not json");
  assert.deepEqual(readQueue(storage, "w1"), []);
  storage.setItem(
    "outrunner:queue:w1",
    JSON.stringify([
      { id: "ok", text: "keep", attachmentIds: [] },
      { id: "empty", text: "  ", attachmentIds: [] },
      { id: "bad", text: 3, attachmentIds: [] },
      { text: "no id", attachmentIds: [] },
    ]),
  );
  assert.deepEqual(readQueue(storage, "w1").map((p) => p.id), ["ok"]);
  // No storage at all (blocked): an empty queue, not a throw.
  assert.deepEqual(readQueue(null, "w1"), []);
});

test("the queue sends only once the turn is over and the session can take it", () => {
  const ready = { queued: 2, attached: true, working: false, waitingOnUser: false, held: false, awaitingLast: false };
  assert.equal(queueDrains(ready), true);
  assert.equal(queueDrains({ ...ready, queued: 0 }), false);
  assert.equal(queueDrains({ ...ready, working: true }), false);
  assert.equal(queueDrains({ ...ready, attached: false }), false);
  // Claude asked something: the answer comes first.
  assert.equal(queueDrains({ ...ready, waitingOnUser: true }), false);
  // A send of it failed: held until the user retries.
  assert.equal(queueDrains({ ...ready, held: true }), false);
  // The last one sent isn't in the conversation yet (a prompt of files alone
  // shows no bubble meanwhile): the next waits for it, not into its turn.
  assert.equal(queueDrains({ ...ready, awaitingLast: true }), false);
});

test("startup input stays durable with its key, attachments and original echo anchor until acknowledged", () => {
  const storage = memory();
  const queue = [{ id: "stable-key", text: "Follow up", attachmentIds: ["image-id"], startup: true, sentAt: 1, mode: "plan" as const }];
  assert.equal(writeQueue(storage, "w", queue), true);
  assert.deepEqual(readQueue(storage, "w"), queue);
  assert.equal(writeQueue(null, "w", queue), false);
  const full = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(writeQueue(full, "w", []), true);
  assert.equal(writeQueue(full, "w", queue), false);
});

test("start over carries the ordered queue and files without carrying another conversation's echo anchors", async () => {
  const { transferQueue, editQueued } = await import("@/lib/session/prompt-queue");
  const storage = memory();
  const queue = [
    { id: "a", text: "first", attachmentIds: ["a1"], startup: true, sentAt: 3 },
    { id: "b", text: "second", attachmentIds: [], startup: true },
  ];
  writeQueue(storage, "old", queue);
  assert.equal(transferQueue(storage, "old", "new"), true);
  assert.deepEqual(readQueue(storage, "old"), []);
  assert.deepEqual(readQueue(storage, "new").map((p) => [p.id, p.text, p.attachmentIds]), queue.map((p) => [p.id, p.text, p.attachmentIds]));
  assert.ok(readQueue(storage, "new").every((p) => p.sentAt === undefined));
  // A delivery that may already have landed cannot change its key's payload.
  assert.deepEqual(editQueued(queue, "a", "different"), queue);
  writeQueue(storage, "old", queue);
  const full = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(transferQueue(full, "old", "other"), false);
  assert.deepEqual(readQueue(storage, "old"), queue);
});
