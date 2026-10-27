import assert from "node:assert/strict";
import { test } from "node:test";

import { pastKeeping, type Removal, type RemovalDeps, type RemovedBox, settleRemoval } from "@/lib/orgs/removal";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-30T12:00:00Z");

function removal(daysAgo: number): Removal {
  return { orgId: "org", userId: "u", removedAt: new Date(now.getTime() - daysAgo * DAY) };
}

function deps(boxes: RemovedBox[], sessions: string[], fail: string[] = [], removed: boolean[] = []) {
  const log: string[] = [];
  const step = (line: string) => {
    log.push(line);
    if (fail.includes(line)) throw new Error(line);
  };
  let asked = 0;
  const d: RemovalDeps = {
    now: () => now,
    // As many answers as the test gives, then still removed.
    stillRemoved: async () => removed[asked++] ?? true,
    boxes: async () => boxes,
    sessions: async () => sessions,
    pause: async (box) => step(`pause ${box.id}`),
    remove: async (box) => step(`remove ${box.id}`),
    end: async (id) => step(`end ${id}`),
    forget: async () => step("forget"),
    log: (message) => log.push(`log: ${message}`),
  };
  return { d, log };
}

const running: RemovedBox = { id: "b1", sandboxId: "s1", status: "ready", pooled: false };
const paused: RemovedBox = { id: "b2", sandboxId: "s2", status: "stopped", pooled: false };
const pooled: RemovedBox = { id: "p1", sandboxId: "s3", status: "stopped", pooled: true };
const gone: RemovedBox = { id: "b3", sandboxId: null, status: "stopped", pooled: false };

test("just removed: running boxes pause, pooled ones (their GitHub token) go, sessions stay", async () => {
  const { d, log } = deps([running, paused, pooled, gone], ["w1", "w2"]);
  await settleRemoval(removal(0), d);
  assert.deepEqual(log, ["pause b1", "remove p1"]);
});

test("30 days on: every box goes, every session ends, and the record with them", async () => {
  const { d, log } = deps([running, paused, pooled, gone], ["w1", "w2"]);
  await settleRemoval(removal(30), d);
  assert.deepEqual(log, ["remove b1", "remove b2", "remove p1", "end w1", "end w2", "forget"]);
});

test("a step that fails is logged, the rest still run, and the record stays for the next run", async () => {
  const { d, log } = deps([running, paused], ["w1", "w2"], ["remove b1", "end w2"]);
  await settleRemoval(removal(31), d);
  assert.equal(log.includes("forget"), false);
  assert.ok(log.includes("remove b2"));
  assert.ok(log.includes("end w1"));
  assert.equal(log.filter((l) => l.startsWith("log: ")).length, 2);
});

test("the sessions are kept for 30 days to the minute", () => {
  assert.equal(pastKeeping(removal(29.99), now), false);
  assert.equal(pastKeeping(removal(30), now), true);
});

test("someone who came back since the removal was read keeps everything", async () => {
  const { d, log } = deps([running, pooled], ["w1"], [], [false]);
  await settleRemoval(removal(31), d);
  assert.deepEqual(log, []);
});

test("someone who came back while their boxes were being listed keeps them too", async () => {
  const { d, log } = deps([running, pooled], ["w1"], [], [true, false]);
  await settleRemoval(removal(31), d);
  assert.deepEqual(log, []);
});
