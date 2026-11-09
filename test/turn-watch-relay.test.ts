import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceStatus } from "@/lib/runtime/types";
import { CONFIRM_MS, type WatchState } from "@/lib/session/turn-watch";
import { TrackerRefusedError } from "@/lib/trackers/errors";
import type { LinearActivity } from "@/lib/trackers/linear";
import { checkTurnRelay, type RelayDeps, type RelayLook, type RelayRow, STILL_WORKING, THOUGHT_EVERY_MS } from "@/lib/trackers/turn-watch-relay";

const SENT = 1_800_000_000_000;
const MINUTE = 60_000;

function watch(over: Partial<WatchState> = {}): WatchState {
  return { sentAt: SENT, baselineActivity: SENT - 1000, seenWorking: false, quietSince: null, quietActivity: null, lastMessage: null, unreachableSince: null, ...over };
}

const iso = (ms: number) => new Date(ms).toISOString();
const summary = (message: string | null, at: number, state = "ready") => ({ lastAssistantMessage: message, lastActivity: iso(at), state });

function harness(setup: { row?: Partial<RelayRow>; status?: WorkspaceStatus; errorMessage?: string; look?: RelayLook; gone?: boolean; sayFails?: boolean; now: number; jira?: boolean; connected?: boolean }) {
  const said: LinearActivity[] = [];
  const log = { stopped: 0, restored: 0, questionsReleased: 0, thoughtsRestored: 0 };
  let row: RelayRow = {
    agentSessionId: "a",
    installationId: "i",
    orgId: "o",
    teamId: "t",
    workspaceId: "w",
    stage: "working",
    relayUntil: SENT + 120 * MINUTE,
    relayedHash: null,
    watch: watch(),
    lastSaidAt: SENT,
    saidHash: null,
    ...setup.row,
  };
  let asked: string | null = null;
  let now = setup.now;
  const say = async (_i: string, _a: string, content: LinearActivity) => {
    if (setup.sayFails) throw new Error("Linear is down");
    said.push(content);
  };
  const deps: RelayDeps = {
    trackerName: setup.jira ? "Jira" : "Linear",
    thoughtEveryMs: setup.jira ? null : THOUGHT_EVERY_MS,
    questionHint: setup.jira ? "To answer, reply here and mention Outrunner." : null,
    messageMax: setup.jira ? 100 : null,
    reviveHint: setup.jira ? "Assign or mention Outrunner again to bring it back." : "Delegate the issue again to bring it back.",
    load: async () => row,
    connected: async () => setup.connected ?? true,
    session: async () => (setup.gone ? null : { status: setup.status ?? "ready", errorMessage: setup.errorMessage }),
    look: async () => setup.look ?? { reachable: true, working: true, summary: summary("Earlier text", SENT + 1000) },
    saveWatch: async (_a, sentAt, state) => {
      if (row.watch?.sentAt === sentAt) row = { ...row, watch: state };
    },
    claimFinal: async (_a, digest, sentAt) => {
      if (row.relayUntil === null || row.watch?.sentAt !== sentAt) return false;
      row = { ...row, relayUntil: null, watch: null, relayedHash: digest };
      return true;
    },
    restoreFinal: async (_a, previous) => {
      log.restored += 1;
      row = previous;
    },
    claimQuestion: async (_a, digest) => {
      if (asked === digest) return false;
      asked = digest;
      return true;
    },
    releaseQuestion: async () => {
      log.questionsReleased += 1;
      asked = null;
    },
    claimThought: async (_a, cutoff, at, saidHash) => {
      if (row.lastSaidAt !== null && row.lastSaidAt > cutoff) return false;
      row = { ...row, lastSaidAt: at, saidHash };
      return true;
    },
    restoreThought: async (_a, previous) => {
      log.thoughtsRestored += 1;
      row = { ...row, ...previous };
    },
    say,
    stop: async () => {
      log.stopped += 1;
    },
    sessionUrl: (id) => `https://app/workspaces/${id}`,
    now: () => now,
  };
  return { deps, said, log, row: () => row, at: (ms: number) => (now = ms), look: () => checkTurnRelay("a", deps) };
}

test("a tool running quietly for minutes after earlier text isn't the end of the turn", async () => {
  // The finding: 20s of quiet with a last message read as over under the summary's rule.
  const h = harness({ now: SENT + 5 * MINUTE, look: { reachable: true, working: true, summary: summary("I'll run the tests.", SENT + 60_000) } });
  assert.equal(await h.look(), false);
  assert.equal(h.said.length, 0);
  assert.notEqual(h.row().relayUntil, null, "the real end is still awaited");
  assert.equal(h.row().watch?.seenWorking, true);

  // And when it does end, that's what's said.
  const done = { reachable: true, working: false, summary: summary("All 40 tests pass.", SENT + 6 * MINUTE) };
  const ended = harness({ now: SENT + 7 * MINUTE, row: { watch: watch({ seenWorking: true, lastMessage: "I'll run the tests." }) }, look: done });
  assert.equal(await ended.look(), false, "an end is confirmed by a second look");
  assert.equal(ended.said.length, 0);
  ended.at(SENT + 7 * MINUTE + CONFIRM_MS);
  assert.equal(await ended.look(), true);
  assert.equal(ended.said.length, 1);
  assert.equal(ended.said[0]?.type, "response");
  assert.match(ended.said[0]?.body ?? "", /All 40 tests pass\.[\s\S]*Open the session/);
});

test("the end of a turn is said once, by whichever look gets there first", async () => {
  const quiet = { reachable: true, working: false, summary: summary("Done.", SENT + MINUTE) };
  const h = harness({ now: SENT + 2 * MINUTE, row: { watch: watch({ seenWorking: true, quietSince: SENT, quietActivity: iso(SENT + MINUTE) }) }, look: quiet });
  assert.equal(await h.look(), true);
  assert.equal(await h.look(), true);
  assert.equal(h.said.length, 1);
  assert.equal(h.row().relayUntil, null);
});

test("a failed say gives the end back, for the next look", async () => {
  const quiet = { reachable: true, working: false, summary: summary("Done.", SENT + MINUTE) };
  const h = harness({ now: SENT + 2 * MINUTE, sayFails: true, row: { watch: watch({ seenWorking: true, quietSince: SENT, quietActivity: iso(SENT + MINUTE) }) }, look: quiet });
  await assert.rejects(h.look());
  assert.equal(h.log.restored, 1);
  assert.notEqual(h.row().relayUntil, null);
});

test("asleep, the turn is over, with the reply last read", async () => {
  const h = harness({ now: SENT + MINUTE, status: "suspended", row: { watch: watch({ lastMessage: "Pushed it." }) } });
  assert.equal(await h.look(), true);
  assert.match(h.said[0]?.body ?? "", /Pushed it\./);
  assert.equal(h.said[0]?.type, "response");
  const nothing = harness({ now: SENT + MINUTE, status: "suspended" });
  await nothing.look();
  assert.match(nothing.said[0]?.body ?? "", /nothing to say/);
});

test("a dead box is said as soon as it's known, not after two silent hours", async () => {
  const look = { reachable: false, working: null, summary: null };
  const h = harness({ now: SENT + MINUTE, look });
  assert.equal(await h.look(), false);
  assert.equal(h.said.length, 0);
  h.at(SENT + 7 * MINUTE);
  assert.equal(await h.look(), true);
  assert.equal(h.said[0]?.type, "error");
  assert.match(h.said[0]?.body ?? "", /its box stopped answering[\s\S]*Open the session/);
  assert.equal(h.log.stopped, 0, "only a failed session stops: its box may come back");
});

test("a failed session says why first, then stops; if it can't say, it hasn't stopped", async () => {
  const h = harness({ now: SENT + MINUTE, status: "failed", errorMessage: "Out of disk" });
  assert.equal(await h.look(), true);
  assert.equal(h.said[0]?.type, "error");
  assert.match(h.said[0]?.body ?? "", /Out of disk/);
  assert.equal(h.log.stopped, 1);
  const quietly = harness({ now: SENT + MINUTE, status: "failed", sayFails: true });
  await assert.rejects(quietly.look());
  assert.equal(quietly.log.stopped, 0);
  assert.notEqual(quietly.row().relayUntil, null);
});

test("archived on purpose says so; a session gone says so", async () => {
  const h = harness({ now: SENT + MINUTE, status: "archived" });
  assert.equal(await h.look(), true);
  assert.match(h.said[0]?.body ?? "", /archived/);
  const gone = harness({ now: SENT + MINUTE, gone: true });
  assert.equal(await gone.look(), true);
  assert.equal(gone.said[0]?.type, "error");
});

test("a question is an elicitation, once a wait, and the watch stays open for its answer", async () => {
  const look: RelayLook = { reachable: true, working: true, waiting: "question", waitingToolId: "tool-1", summary: summary("Which database?", SENT + MINUTE) };
  const h = harness({ now: SENT + 2 * MINUTE, look });
  assert.equal(await h.look(), false);
  assert.equal(await h.look(), false);
  assert.equal(h.said.length, 1);
  assert.equal(h.said[0]?.type, "elicitation");
  assert.match(h.said[0]?.body ?? "", /Which database\?/);
  assert.notEqual(h.row().relayUntil, null);
});

test("a plan or secrets is sent to the session, as Linear can't answer those", async () => {
  for (const waiting of ["plan", "secrets"] as const) {
    const h = harness({ now: SENT + 2 * MINUTE, look: { reachable: true, working: true, waiting, waitingToolId: "t", summary: summary("x", SENT + MINUTE) } });
    await h.look();
    assert.equal(h.said[0]?.type, "elicitation");
    assert.match(h.said[0]?.body ?? "", new RegExp(`${waiting === "plan" ? "plan" : "secrets"}[\\s\\S]*Open the session`));
    assert.doesNotMatch(h.said[0]?.body ?? "", /\bx\b/);
  }
});

test("a question that can't be said is asked again next look", async () => {
  const look: RelayLook = { reachable: true, working: true, waiting: "question", waitingToolId: "tool-1", summary: summary("Which?", SENT + MINUTE) };
  const h = harness({ now: SENT + 2 * MINUTE, look, sayFails: true });
  await assert.rejects(h.look());
  assert.equal(h.log.questionsReleased, 1);
});

test("working a long time, a thought goes out before Linear marks it stale: its latest words, once", async () => {
  const early = harness({ now: SENT + 10 * MINUTE });
  await early.look();
  assert.equal(early.said.length, 0, "too soon");

  const h = harness({ now: SENT + THOUGHT_EVERY_MS });
  assert.equal(await h.look(), false);
  assert.deepEqual(h.said, [{ type: "thought", body: "Earlier text" }]);
  await h.look();
  assert.equal(h.said.length, 1, "rate limited");

  h.at(SENT + 2 * THOUGHT_EVERY_MS);
  await h.look();
  assert.deepEqual(h.said[1], { type: "thought", body: STILL_WORKING }, "the same words aren't said twice");
});

test("no words yet still says it's working; a failed thought is tried again", async () => {
  const silent = harness({ now: SENT + THOUGHT_EVERY_MS, look: { reachable: true, working: true, summary: summary(null, SENT) } });
  await silent.look();
  assert.deepEqual(silent.said, [{ type: "thought", body: STILL_WORKING }]);
  const failing = harness({ now: SENT + THOUGHT_EVERY_MS, sayFails: true });
  await assert.rejects(failing.look());
  assert.equal(failing.log.thoughtsRestored, 1);
  assert.equal(failing.row().lastSaidAt, SENT);
});

test("out of time, it says so with the link, rather than going quiet", async () => {
  const h = harness({ now: SENT + 121 * MINUTE });
  assert.equal(await h.look(), true);
  assert.equal(h.said[0]?.type, "response");
  assert.match(h.said[0]?.body ?? "", /no more replies will come here[\s\S]*workspaces\/w/);
  assert.equal(h.row().relayUntil, null);
});

test("nothing to watch: stopped, un-watched, or not yet with a session", async () => {
  for (const row of [{ stage: "stopped" }, { relayUntil: null }, { watch: null }, { workspaceId: null }]) {
    const h = harness({ now: SENT + MINUTE, row });
    assert.equal(await h.look(), true);
    assert.deepEqual(h.said, []);
  }
});

test("a send since keeps its own watch: an older look doesn't overwrite it", async () => {
  const h = harness({ now: SENT + MINUTE });
  await h.deps.saveWatch("a", SENT - 1, watch({ sentAt: SENT - 1, seenWorking: true }));
  assert.equal(h.row().watch?.seenWorking, false);
});

test("Jira: the quiet tool too, as both share the watch", async () => {
  const h = harness({ jira: true, now: SENT + 5 * MINUTE, look: { reachable: true, working: true, summary: summary("I'll run the tests.", SENT + 60_000) } });
  assert.equal(await h.look(), false);
  assert.equal(h.said.length, 0);
  assert.notEqual(h.row().relayUntil, null);
});

test("Jira: no heartbeat, however long it works", async () => {
  const h = harness({ jira: true, now: SENT + 60 * MINUTE });
  assert.equal(await h.look(), false);
  assert.equal(h.said.length, 0);
});

test("Jira: out of time says so with the link, and says where", async () => {
  const h = harness({ jira: true, now: SENT + 121 * MINUTE });
  assert.equal(await h.look(), true);
  assert.match(h.said[0]?.body ?? "", /watches from Jira, so no more replies will come here[\s\S]*workspaces\/w/);
});

test("Jira: a long reply loses its end, not the link after it", async () => {
  const quiet = { reachable: true, working: false, summary: summary("x".repeat(500), SENT + MINUTE) };
  const h = harness({ jira: true, now: SENT + 2 * MINUTE, row: { watch: watch({ seenWorking: true, quietSince: SENT, quietActivity: iso(SENT + MINUTE) }) }, look: quiet });
  await h.look();
  const body = h.said[0]?.body ?? "";
  assert.ok(body.length < 200);
  assert.match(body, /x…\n\n\[Open the session\]\(https:\/\/app\/workspaces\/w\)$/);
});

test("Jira: a question says how to answer it; a plan doesn't invite a reply", async () => {
  const question: RelayLook = { reachable: true, working: true, waiting: "question", waitingToolId: "t", summary: summary("Which one?", SENT + MINUTE) };
  const asked = harness({ jira: true, now: SENT + 2 * MINUTE, look: question });
  await asked.look();
  assert.match(asked.said[0]?.body ?? "", /Which one\?\n\nTo answer, reply here and mention Outrunner\.\n\n\[Open/);
  const plan = harness({ jira: true, now: SENT + 2 * MINUTE, look: { ...question, waiting: "plan" } });
  await plan.look();
  assert.doesNotMatch(plan.said[0]?.body ?? "", /To answer/);
});

test("Jira: archived says how to bring it back", async () => {
  const h = harness({ jira: true, now: SENT + MINUTE, status: "archived" });
  await h.look();
  assert.match(h.said[0]?.body ?? "", /Assign or mention Outrunner again/);
});

test("disconnected, or the org's left: it stops, saying nothing there", async () => {
  const h = harness({ now: SENT + 121 * MINUTE, connected: false });
  assert.equal(await h.look(), true);
  assert.equal(h.said.length, 0);
  assert.equal(h.log.stopped, 1);
});

test("a tracker that refuses for good: it stops, rather than asking until the watch runs out", async () => {
  const h = harness({ now: SENT + 2 * MINUTE, status: "failed" });
  h.deps.say = async () => {
    throw new TrackerRefusedError("gone");
  };
  assert.equal(await h.look(), true);
  assert.equal(h.log.stopped, 1);
});

test("past the watch, a last word that can't be said isn't tried for ever", async () => {
  const h = harness({ now: SENT + 25 * 60 * MINUTE, sayFails: true });
  assert.equal(await h.look(), true);
  assert.equal(h.log.stopped, 1);
});

test("a turn sent after this read isn't closed by the last one's ending", async () => {
  const over = { reachable: true, working: false, summary: summary("Done", SENT + 1000) };
  const newer = SENT + 120 * MINUTE;
  const h = harness({ now: SENT + 121 * MINUTE, look: over, row: { watch: watch({ sentAt: newer }) } });
  // Read before a steer opened that watch: this look still sees the old turn, over.
  const stale = { ...h.row(), watch: watch({ seenWorking: true, quietSince: SENT }) };
  h.deps.load = async () => stale;
  await h.look();
  assert.equal(h.said.length, 0, "nothing said for the old turn");
  assert.equal(h.row().watch?.sentAt, newer, "the newer turn's watch stays");
  assert.notEqual(h.row().relayUntil, null);
});
