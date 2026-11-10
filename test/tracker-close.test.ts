import assert from "node:assert/strict";
import { test } from "node:test";

import { closeFromTrackerWith, type TrackerClose } from "@/lib/trackers/close";

const DUPLICATE: TrackerClose = { status: "duplicate", duplicateOf: "original" };

function run(close: TrackerClose, setup: { changed: boolean; current?: { status: string; duplicateOf: string | null } | null; repointFails?: boolean }) {
  const log = { repointed: [] as string[], looked: 0 };
  const done = closeFromTrackerWith(close, {
    apply: async () => setup.changed,
    current: async () => {
      log.looked += 1;
      return setup.current ?? null;
    },
    repoint: async (to) => {
      if (setup.repointFails) throw new Error("database down");
      log.repointed.push(to);
    },
  });
  return { done, log };
}

test("closing as a duplicate repoints what pointed at it", async () => {
  const { done, log } = run(DUPLICATE, { changed: true });
  await done;
  assert.deepEqual(log.repointed, ["original"]);
  assert.equal(log.looked, 0);
});

test("a repoint that failed is finished by the redelivery, whose update finds it already closed", async () => {
  const first = run(DUPLICATE, { changed: true, repointFails: true });
  await assert.rejects(first.done, /database down/, "so the event stays unseen");
  const again = run(DUPLICATE, { changed: false, current: { status: "duplicate", duplicateOf: "original" } });
  await again.done;
  assert.deepEqual(again.log.repointed, ["original"]);
});

test("decided here meanwhile, what points at it stays", async () => {
  for (const current of [{ status: "declined", duplicateOf: null }, { status: "done", duplicateOf: null }, { status: "duplicate", duplicateOf: "another" }, null]) {
    const { done, log } = run(DUPLICATE, { changed: false, current });
    await done;
    assert.deepEqual(log.repointed, [], JSON.stringify(current));
  }
});

test("any other close repoints nothing", async () => {
  for (const close of [{ status: "done" }, { status: "declined" }] as TrackerClose[]) {
    for (const changed of [true, false]) {
      const { done, log } = run(close, { changed });
      await done;
      assert.deepEqual(log, { repointed: [], looked: 0 });
    }
  }
});
