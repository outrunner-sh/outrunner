import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRunnerWatch, type RecordedEvent, type WatchDeps, type WatchRow } from "@/lib/missions/watch";
import type { Workspace } from "@/lib/runtime/types";

const T0 = Date.parse("2026-11-02T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function setup(runner: Partial<Workspace> = {}, look: Partial<Awaited<ReturnType<WatchDeps["look"]>>> = {}) {
  let clock = T0 + 60_000;
  const recorded: RecordedEvent[] = [];
  const keys = new Set<string>();
  const sent: string[] = [];
  const queue = ["then do Y"];
  let row: WatchRow | null = {
    workspaceId: "r1",
    sentAt: iso(T0),
    baselineActivity: iso(T0 - 1000),
    seenWorking: false,
    quietSince: null,
    quietActivity: null,
    lastMessage: null,
    unreachableSince: null,
  };
  const session = { id: "r1", parentMissionId: "m1", ownerId: "alice", status: "ready", title: "Fix login", branch: "runtime/x", errorMessage: null, ...runner } as Workspace;
  const deps: WatchDeps = {
    session: async () => session,
    look: async () => ({
      reachable: true,
      working: false,
      summary: { lastAssistantMessage: "Opened #7.", lastActivity: iso(T0 + 10_000), state: "running" } as never,
      ...look,
    }),
    save: async (r) => {
      row = r;
    },
    close: async (_id, sentAt) => {
      // As the database's: only the watch on that turn.
      if (row && row.sentAt === sentAt) row = null;
    },
    record: async (e) => {
      if (keys.has(e.key)) return false;
      keys.add(e.key);
      recorded.push(e);
      return true;
    },
    takeQueued: async () => {
      const content = queue.shift();
      return content ? { id: "q", content } : null;
    },
    returnQueued: async () => undefined,
    sendAndWatch: async (_r, content) => {
      sent.push(content);
      return true;
    },
    now: () => clock,
  };
  return {
    deps,
    recorded,
    sent,
    row: () => row,
    tick: (ms: number) => void (clock += ms),
    reopen: (sentAt: string) => {
      row = { ...(row as WatchRow), sentAt, quietSince: null, quietActivity: null, seenWorking: false };
    },
  };
}

test("a turn's end is recorded once as finished, even seen by two at once, then the queue goes", async () => {
  const w = setup();
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "waiting");
  const confirming = w.row()!;
  w.tick(16_000);
  const outcomes = await Promise.all([checkRunnerWatch(confirming, w.deps), checkRunnerWatch(confirming, w.deps)]);
  assert.deepEqual(outcomes, ["finished", "finished"]);
  assert.equal(w.recorded.length, 1);
  assert.deepEqual(w.recorded[0], {
    missionId: "m1",
    runnerId: "r1",
    kind: "finished",
    payload: { runner: "Fix login", response: "Opened #7." },
    key: `finished:r1:${iso(T0)}`,
  });
  assert.equal(w.row(), null);
  assert.deepEqual(w.sent, ["then do Y"]);
});

test("a spawn whose setup failed reaches the Mission as needing attention, with the cause", async () => {
  const w = setup({ status: "failed", errorMessage: "Your plan's cloud hours are used up." });
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "needs_attention");
  assert.equal(w.recorded[0].kind, "needs_attention");
  assert.equal(w.recorded[0].payload.reason, "its session failed: Your plan's cloud hours are used up.");
});

test("a Runner whose agent crashed mid-turn reaches the Mission as needing attention", async () => {
  const w = setup({}, { summary: { lastAssistantMessage: "x", lastActivity: iso(T0 + 1000), state: "exited" } as never });
  // Seen once, then confirmed: a relaunch passes through exited too.
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "waiting");
  w.tick(16_000);
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "needs_attention");
  assert.equal(w.recorded[0].payload.reason, "its agent exited");
});

test("a Runner whose box went quiet and slept: finished with the reply last read", async () => {
  const w = setup({}, { working: true });
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "waiting");
  const mid = setup({ status: "suspended" });
  const row = { ...w.row()!, lastMessage: "Pushed; PR #7 is open." };
  assert.equal(await checkRunnerWatch(row, mid.deps), "finished");
  assert.deepEqual(mid.recorded[0].payload, { runner: "Fix login", response: "Pushed; PR #7 is open.", asleep: true });
});

test("a Runner archived on purpose mid-watch: no event", async () => {
  const w = setup({ status: "archived" });
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "closed");
  assert.equal(w.recorded.length, 0);
});

test("a session that isn't a Runner closes its watch quietly", async () => {
  const w = setup({ parentMissionId: null });
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "closed");
  assert.equal(w.recorded.length, 0);
});

test("a Runner waiting on a person reaches its Mission once a wait, and the watch stays for the turn's end", async () => {
  const w = setup({}, { working: true, waiting: "question", waitingToolId: "tu9" } as never);
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "needs_attention");
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "needs_attention");
  assert.equal(w.recorded.length, 1);
  assert.match(String(w.recorded[0].payload.reason), /asked a question only a person can answer/);
  assert.notEqual(w.row(), null);
});

test("a turn's end closes only its own watch, not one a send since has opened", async () => {
  const w = setup();
  assert.equal(await checkRunnerWatch(w.row()!, w.deps), "waiting");
  const ending = w.row()!;
  w.tick(16_000);
  // The Mission sends again meanwhile: a new watch, on the next turn.
  w.reopen(iso(T0 + 70_000));
  assert.equal(await checkRunnerWatch(ending, w.deps), "finished");
  assert.equal(w.row()?.sentAt, iso(T0 + 70_000));
});
