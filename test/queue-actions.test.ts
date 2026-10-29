import assert from "node:assert/strict";
import { test } from "node:test";
import { runQueuedAction } from "@/lib/session/queue-actions";
import { queueDrains, editQueued } from "@/lib/session/prompt-queue";

const prompt = { id: "a", text: "first", attachmentIds: ["image"] };
const ready = { queued: 1, attached: true, working: false, waitingOnUser: false, held: false, awaitingLast: false };

test("send now claims its prompt before the stop settles and rejects double clicks", async () => {
  const gate = { current: false };
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let queue = [prompt];
  let held = false;
  let stops = 0;
  const sent: string[] = [];
  const steps = {
    take: () => { held = true; queue = []; return prompt; },
    interrupt: async () => { stops++; await stopped; },
    send: async (item: typeof prompt) => { sent.push(item.id); },
    restore: () => { throw new Error("unexpected restore"); },
    settled: () => {},
  };
  const first = runQueuedAction(gate, steps);
  assert.equal(gate.current, true);
  assert.deepEqual(queue, []);
  assert.equal(queueDrains({ ...ready, held }), false, "an early idle frame cannot drain the queue");
  await runQueuedAction(gate, steps);
  assert.equal(stops, 1);
  release();
  await first;
  assert.deepEqual(sent, ["a"]);
  assert.equal(gate.current, false);
});

test("a refused stop restores the claimed prompt and sends nothing", async () => {
  const gate = { current: false };
  let queue = [prompt];
  let sends = 0;
  await assert.rejects(runQueuedAction(gate, {
    take: () => { queue = []; return prompt; },
    interrupt: async () => { throw new Error("stop refused"); },
    send: async () => { sends++; },
    restore: (item) => { queue = [item]; }, settled: () => {},
  }), /stop refused/);
  assert.deepEqual(queue, [prompt]);
  assert.equal(sends, 0);
  assert.equal(gate.current, false);
});

test("editing holds the queue until the edited words have been committed", () => {
  assert.equal(queueDrains({ ...ready, editing: true }), false);
  const queue = editQueued([prompt], "a", "edited");
  assert.equal(queue[0].text, "edited");
  assert.equal(queueDrains({ ...ready, editing: false }), true);
});
