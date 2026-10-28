import assert from "node:assert/strict";
import { test } from "node:test";

import { inPool } from "@/lib/session/pool";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the next item starts as soon as any one finishes, never more than `width` at once", async () => {
  let running = 0;
  let most = 0;
  const order: number[] = [];
  // One slow item doesn't hold the others back as a batch would.
  const times = [60, 5, 5, 5, 5, 5];
  await inPool(times.map((ms, i) => ({ ms, i })), 2, async ({ ms, i }) => {
    running++;
    most = Math.max(most, running);
    await wait(ms);
    order.push(i);
    running--;
  });
  assert.equal(most, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 0]);
});

test("nothing starts once the budget has passed; what started finishes", async () => {
  let clock = 0;
  const done: number[] = [];
  const { started } = await inPool(
    [1, 2, 3, 4, 5],
    1,
    async (n) => {
      clock += 10;
      done.push(n);
    },
    { until: 25, now: () => clock },
  );
  assert.equal(started, 3);
  assert.deepEqual(done, [1, 2, 3]);
});

test("an empty list does nothing", async () => {
  assert.deepEqual(await inPool([], 4, async () => assert.fail("ran")), { started: 0 });
});
