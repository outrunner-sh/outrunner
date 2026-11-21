import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTENTION_AFTER_MS,
  nextNeedingYou,
  sessionStanding,
  STUCK_AFTER_MS,
  type SessionActivity,
  type StandingInput,
} from "@/lib/session/standing";
import { ERROR_MARK } from "@/lib/session/turn-state";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const idle: SessionActivity = {
  turn: "idle",
  turnStartedAt: null,
  waiting: null,
  waitingSince: null,
  repliedAt: null,
  replyPreview: null,
  eventAt: ago(5 * MIN),
  createdAt: ago(60 * MIN),
};

function standing(patch: Partial<Omit<StandingInput, "workspace">> & { workspace?: Partial<StandingInput["workspace"]> } = {}) {
  return sessionStanding({
    activity: idle,
    pullRequest: null,
    mark: null,
    owner: true,
    now: NOW,
    ...patch,
    workspace: { status: "ready", createdAt: ago(60 * MIN), updatedAt: ago(5 * MIN), lastActiveAt: ago(5 * MIN), ...patch.workspace },
  });
}

test("a question, a plan, secrets, an error or a stuck turn need you", () => {
  for (const waiting of ["question", "plan", "secrets"] as const) {
    const s = standing({ activity: { ...idle, turn: "working", waiting, waitingSince: ago(MIN) } });
    assert.deepEqual([s.standing, s.reason], ["needs_you", waiting]);
  }
  assert.deepEqual(
    [standing({ workspace: { status: "failed" } }).standing, standing({ workspace: { status: "failed" } }).reason],
    ["needs_you", "error"],
  );
  const stuck = standing({ activity: { ...idle, turn: "working", turnStartedAt: ago(STUCK_AFTER_MS + MIN), eventAt: ago(STUCK_AFTER_MS + MIN) } });
  assert.deepEqual([stuck.standing, stuck.reason], ["needs_you", "stuck"]);
  // A setup that never finished is stuck too.
  assert.equal(standing({ workspace: { status: "provisioning", createdAt: ago(60 * MIN) } }).reason, "stuck");
});

test("a turn going on, or a session setting up or coming back, is working", () => {
  assert.equal(standing({ activity: { ...idle, turn: "working", turnStartedAt: ago(MIN), eventAt: ago(MIN) } }).standing, "working");
  assert.equal(standing({ workspace: { status: "provisioning", createdAt: ago(MIN) } }).standing, "working");
  assert.equal(standing({ workspace: { status: "restoring" } }).standing, "working");
});

test("a paused or archived session is never working or waiting, whatever its stream last said", () => {
  const s = standing({ workspace: { status: "archived" }, activity: { ...idle, turn: "working", waiting: "question", waitingSince: ago(MIN) } });
  assert.equal(s.standing, "needs_you");
});

test("an open pull request is in review; a merged one is done", () => {
  assert.equal(standing({ pullRequest: { state: "open", stateAt: null } }).standing, "in_review");
  assert.equal(standing({ pullRequest: { state: "merged", stateAt: ago(MIN) } }).standing, "done");
  // A question beats the pull request: it still needs you.
  assert.equal(
    standing({ pullRequest: { state: "open", stateAt: null }, activity: { ...idle, waiting: "question", waitingSince: ago(MIN) } }).standing,
    "needs_you",
  );
});

test("idle sessions and closed unmerged pull requests need you", () => {
  const quiet = { workspace: { lastActiveAt: ago(ATTENTION_AFTER_MS + MIN), createdAt: ago(ATTENTION_AFTER_MS * 2) }, activity: null };
  assert.equal(standing(quiet).standing, "needs_you");
  assert.equal(standing({ ...quiet, pullRequest: { state: "closed", stateAt: null } }).standing, "needs_you");
  assert.equal(standing({ workspace: { lastActiveAt: ago(ATTENTION_AFTER_MS - MIN) }, activity: null }).standing, "needs_you");
});

test("a move by hand holds until the session needs you again after it", () => {
  const moved = { pinnedAt: null, movedTo: "in_review" as const, movedAt: ago(10 * MIN), seenAt: null };
  const s = standing({ mark: moved, pullRequest: { state: "open", stateAt: ago(20 * MIN) } });
  assert.deepEqual([s.standing, s.moved], ["in_review", true]);
  // A question from before the move doesn't undo it...
  assert.equal(standing({ mark: moved, activity: { ...idle, waiting: "question", waitingSince: ago(20 * MIN) } }).standing, "in_review");
  // ...one since does.
  const asked = standing({ mark: moved, activity: { ...idle, waiting: "question", waitingSince: ago(MIN) } });
  assert.deepEqual([asked.standing, asked.reason, asked.moved], ["needs_you", "question", false]);
});

test("a session moved to Working by hand is idle unless its agent is at work", () => {
  const moved = { pinnedAt: null, movedTo: "working" as const, movedAt: ago(10 * MIN), seenAt: null };
  const resting = standing({ mark: moved, workspace: { lastActiveAt: ago(60 * MIN) } });
  assert.deepEqual([resting.standing, resting.moved, resting.idle], ["working", true, true]);
  const busy = standing({ mark: moved, activity: { ...idle, turn: "working", turnStartedAt: ago(MIN), eventAt: ago(MIN) } });
  assert.deepEqual([busy.standing, busy.idle], ["working", false]);
  // Coming back counts as at work, as it does for the automatic group.
  assert.equal(standing({ mark: moved, workspace: { status: "restoring" } }).idle, false);
  assert.equal(standing({ activity: { ...idle, turn: "working", turnStartedAt: ago(MIN), eventAt: ago(MIN) } }).idle, false);
});

test("a reply is unread until seen, and replies from before the watch never are", () => {
  const replied = { ...idle, repliedAt: ago(2 * MIN), createdAt: ago(60 * MIN) };
  assert.equal(standing({ activity: replied }).unread, true);
  assert.equal(standing({ activity: replied, mark: { pinnedAt: null, movedTo: null, movedAt: null, seenAt: ago(MIN) } }).unread, false);
  assert.equal(standing({ activity: { ...replied, createdAt: ago(MIN) } }).unread, false);
});

test("a finished turn needs you until its pull request is raised or merged", () => {
  const replied = { ...idle, repliedAt: ago(2 * MIN), createdAt: ago(60 * MIN) };
  const s = standing({ activity: replied });
  assert.deepEqual([s.standing, s.reason], ["needs_you", "replied"]);
  // A paused session's reply is still unread.
  assert.equal(standing({ activity: replied, workspace: { status: "suspended" } }).reason, "replied");
  // Seen, it still needs you until a pull request is raised or merged.
  const seen = { pinnedAt: null, movedTo: null, movedAt: null, seenAt: ago(MIN) };
  assert.equal(standing({ activity: replied, mark: seen }).standing, "needs_you");
  // With a pull request open it stays in review.
  assert.equal(standing({ activity: replied, pullRequest: { state: "open", stateAt: null } }).standing, "in_review");
  // A reply since its pull request merged or closed needs you; one from
  // before was acted on already, as is one when it's unknown when.
  assert.equal(standing({ activity: replied, pullRequest: { state: "merged", stateAt: ago(3 * MIN) } }).reason, "replied");
  assert.equal(standing({ activity: replied, pullRequest: { state: "merged", stateAt: ago(MIN) } }).standing, "done");
  assert.equal(standing({ activity: replied, pullRequest: { state: "closed", stateAt: ago(3 * MIN) } }).reason, "replied");
  assert.equal(standing({ activity: replied, pullRequest: { state: "closed", stateAt: ago(MIN) } }).standing, "needs_you");
  assert.equal(standing({ activity: replied, pullRequest: { state: "merged", stateAt: null } }).standing, "done");
  // Old replies still need you until a pull request is raised or merged.
  const old = ago(ATTENTION_AFTER_MS + MIN);
  const stale = standing({
    activity: { ...replied, repliedAt: old, eventAt: old, createdAt: ago(ATTENTION_AFTER_MS * 2) },
    workspace: { lastActiveAt: old, updatedAt: old, createdAt: ago(ATTENTION_AFTER_MS * 2) },
  });
  assert.equal(stale.standing, "needs_you");
  // Another member's, or one put away, never needs you.
  assert.equal(standing({ activity: replied, owner: false }).standing, "needs_you");
  assert.equal(standing({ activity: replied, workspace: { status: "archived" } }).standing, "needs_you");
  // A move by hand since the reply holds.
  const moved = { pinnedAt: null, movedTo: "in_review" as const, movedAt: ago(MIN), seenAt: null };
  assert.deepEqual([standing({ activity: replied, mark: moved }).standing, standing({ activity: replied, mark: moved }).moved], ["in_review", true]);
  // A reply from before the server read the session is never unread.
  assert.equal(standing({ activity: { ...replied, createdAt: ago(MIN) } }).standing, "needs_you");
});

test("the next session that needs you comes after the one on screen, pinned first, wrapping round", () => {
  const sessions = [
    { id: "a", standing: "needs_you" as const, pinned: false, at: ago(3 * MIN) },
    { id: "b", standing: "needs_you" as const, pinned: false, at: ago(1 * MIN) },
    { id: "c", standing: "done" as const, pinned: false, at: ago(0) },
    { id: "d", standing: "needs_you" as const, pinned: true, at: ago(9 * MIN) },
  ];
  assert.equal(nextNeedingYou(sessions, undefined), "d");
  assert.equal(nextNeedingYou(sessions, "d"), "b");
  assert.equal(nextNeedingYou(sessions, "b"), "a");
  assert.equal(nextNeedingYou(sessions, "a"), "d");
  assert.equal(nextNeedingYou(sessions.slice(0, 1), "a"), null, "only the one on screen");
  assert.equal(nextNeedingYou([sessions[2]], undefined), null);
});

test("a last turn that ended in an API error needs you, read or not", () => {
  const errored = { ...idle, repliedAt: ago(2 * MIN), replyPreview: `${ERROR_MARK}API Error: 400 image input is not supported` };
  const unread = standing({ activity: errored });
  assert.deepEqual([unread.standing, unread.reason], ["needs_you", "error"]);
  // Its tooltip reads the words, not the mark.
  assert.equal(unread.replyPreview, "API Error: 400 image input is not supported");
  // A model's reply that only says "API Error" is no failure.
  assert.equal(standing({ activity: { ...errored, replyPreview: "API Error: 400 means a bad id." } }).reason, "replied");
  const read = standing({ activity: errored, mark: { pinnedAt: null, movedTo: null, movedAt: null, seenAt: ago(MIN) } });
  assert.deepEqual([read.standing, read.reason], ["needs_you", "error"]);
  // Once the next turn is under way, it's working again.
  assert.equal(standing({ activity: { ...errored, turn: "working", turnStartedAt: ago(MIN), eventAt: ago(MIN) } }).standing, "working");
  // Idle sessions without merged pull requests stay in Needs you.
  assert.equal(standing({ activity: errored, workspace: { status: "archived" } }).standing, "needs_you");
  const long = ago(ATTENTION_AFTER_MS + MIN);
  const old = { ...errored, repliedAt: long, eventAt: long };
  assert.equal(standing({ activity: old, workspace: { createdAt: long, lastActiveAt: long } }).standing, "needs_you");
});

test("Done requires a merged pull request even with a legacy manual mark", () => {
  const mark = { pinnedAt: null, movedTo: "done" as const, movedAt: ago(MIN), seenAt: null };
  for (const pullRequest of [null, { state: "open" as const, stateAt: null }, { state: "closed" as const, stateAt: ago(MIN) }]) {
    const result = standing({ mark, pullRequest });
    assert.notEqual(result.standing, "done");
    assert.equal(result.moved, false);
  }
  assert.equal(standing({ mark, pullRequest: { state: "merged", stateAt: ago(MIN) } }).standing, "done");
});
