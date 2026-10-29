import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityNews,
  DELIVERY_GRACE_MS,
  dueFor,
  errorNews,
  pullRequestNews,
  STALE_AFTER_MS,
} from "@/lib/notifications/events";
import { ERROR_MARK, IDLE, type TurnState } from "@/lib/session/turn-state";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const session = { userId: "u", workspaceId: "w", title: "Fix login" };
const working: TurnState = { ...IDLE, turn: "working", turnStartedAt: ago(60_000) };

test("a turn that ends in a reply is news, with the reply's opening words", () => {
  const after: TurnState = { ...IDLE, repliedAt: ago(5_000), replyPreview: "Fixed: the token was stale." };
  assert.deepEqual(activityNews({ before: working, after }, session, NOW), [
    { ...session, kind: "turn_done", eventKey: ago(5_000), body: "Fixed: the token was stale." },
  ]);
  // The same reply read again isn't.
  assert.deepEqual(activityNews({ before: after, after }, session, NOW), []);
});

test("a question, a plan or secrets is news once, by the call that waits", () => {
  const asked: TurnState = { ...working, waiting: "plan", waitingToolId: "call1", waitingSince: ago(1_000) };
  const [news] = activityNews({ before: working, after: asked }, session, NOW);
  assert.deepEqual([news.kind, news.eventKey, news.body], ["needs_input", "call1", "Waiting for you to approve its plan"]);
  assert.deepEqual(activityNews({ before: asked, after: asked }, session, NOW), []);
});

test("a session read for the first time, or news gone stale, tells nothing", () => {
  const after: TurnState = { ...IDLE, repliedAt: ago(5_000) };
  assert.deepEqual(activityNews({ before: null, after }, session, NOW), []);
  const old: TurnState = { ...IDLE, repliedAt: ago(STALE_AFTER_MS + 1) };
  assert.deepEqual(activityNews({ before: working, after: old }, session, NOW), []);
});

test("a pull request that opens or merges is news; one closed unmerged isn't", () => {
  assert.equal(pullRequestNews({ from: null, to: "open", number: 7 }, session)[0].kind, "pr_opened");
  assert.equal(pullRequestNews({ from: "open", to: "merged", number: 7 }, session)[0].body, "Pull request #7 merged");
  assert.deepEqual(pullRequestNews({ from: "open", to: "closed", number: 7 }, session), []);
  // A new one on the branch replacing a closed one, or one reopened.
  const reopened = pullRequestNews({ from: "closed", to: "open", number: 7 }, session)[0];
  assert.deepEqual([reopened.kind, reopened.eventKey, reopened.body], ["pr_opened", "7:reopened", "Pull request #7 reopened"]);
  assert.notEqual(reopened.eventKey, pullRequestNews({ from: null, to: "open", number: 7 }, session)[0].eventKey);
  assert.deepEqual(pullRequestNews({ from: "open", to: "open", number: 7 }, session), []);
});

test("a failure is news once per failure, saying why", () => {
  const news = errorNews({ ...session, failedAt: ago(0), message: "No Claude credential" });
  assert.deepEqual([news.kind, news.eventKey, news.body], ["errored", ago(0), "Errored: No Claude credential"]);
});

test("email and Slack wait a minute, and skip what's seen or turned off", () => {
  const all = { kinds: ["turn_done" as const] };
  const fresh = { kind: "turn_done" as const, createdAt: ago(10_000) };
  const due = { kind: "turn_done" as const, createdAt: ago(DELIVERY_GRACE_MS + 1) };
  assert.equal(dueFor(fresh, all, null, NOW), "wait");
  assert.equal(dueFor(due, all, null, NOW), "send");
  assert.equal(dueFor(due, all, ago(1_000), NOW), "skip", "seen since");
  assert.equal(dueFor(due, all, ago(DELIVERY_GRACE_MS * 2), NOW), "send", "seen before it happened");
  assert.equal(dueFor({ ...due, kind: "pr_opened" }, all, null, NOW), "skip", "a kind turned off");
});

test("a turn that failed is news in Claude Code's words, without the mark that files it", () => {
  const after: TurnState = { ...IDLE, repliedAt: ago(5_000), replyPreview: `${ERROR_MARK}API Error: 400 bad request` };
  assert.deepEqual(activityNews({ before: working, after }, session, NOW), [
    { ...session, kind: "turn_done", eventKey: ago(5_000), body: "API Error: 400 bad request" },
  ]);
});
