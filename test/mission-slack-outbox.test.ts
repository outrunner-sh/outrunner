/**
 * The Slack post queue's delivery (lib/missions/slack-outbox.ts): checked
 * again right before it goes (binding and its revision, mute, the
 * requester's access), never moved to a channel bound since; a long reply
 * resumed at the next chunk after a crash; a send Slack never answered
 * looked for in the thread before posting again, and marked ambiguous when
 * the thread can't settle it; Slack's Retry-After waited; refusals that no
 * retry changes failed at once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { backoffSeconds, chunkMarker, type ClaimedPost, deliverPost, MAX_POST_ATTEMPTS, type OutboxPostDeps } from "@/lib/missions/slack-outbox";
import type { MissionChannel } from "@/lib/missions/slack-store";
import type { Workspace } from "@/lib/runtime/types";
import { SlackApiError, SlackUnknownOutcomeError } from "@/lib/slack/web";

const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };

function claimed(patch: Partial<ClaimedPost> = {}): ClaimedPost {
  return {
    id: "p1",
    opKey: "reply:m1:1731400000.000100:k:a",
    missionId: "m1",
    bindingRevision: "rev1",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1731400000.000100",
    kind: "reply",
    payload: { chunks: ["one", "two", "three"] },
    requester: "ana",
    attempt: 1,
    progress: 0,
    postedTs: [],
    inDoubt: false,
    ...patch,
  };
}

/** A fake Slack: a thread whose messages carry their markers, and sends
 *  that fail as told. */
function slack() {
  const thread: { ts: string; text: string; marker: string; channel: string }[] = [];
  const reactions: string[] = [];
  const progress: number[] = [];
  const state = {
    binding: binding as MissionChannel | null,
    muted: false,
    /** Whether the channel was shared since it was bound; "unknown": Slack can't say. */
    shared: false as boolean | "unknown",
    readers: new Set(["ana"]),
    /** What each next send does, in order; then they succeed. */
    sends: [] as ("ok" | "lost" | "unknown-not-sent" | "ratelimited" | "fatal" | "error")[],
    markers: "ok" as "ok" | "throws" | "incomplete",
  };
  let n = 0;
  const deps: OutboxPostDeps = {
    binding: async () => state.binding,
    muted: async () => state.muted,
    mission: async () => ({ id: "m1", kind: "mission", status: "ready" }) as Workspace,
    canRead: async (userId) => state.readers.has(userId),
    ownChannel: async () => {
      if (state.shared === "unknown") throw new Error("channel_not_found");
      return !state.shared;
    },
    post: async (post, message) => {
      const how = state.sends.shift() ?? "ok";
      if (how === "ratelimited") throw new SlackApiError("chat.postMessage", "ratelimited", 42);
      if (how === "fatal") throw new SlackApiError("chat.postMessage", "channel_not_found");
      if (how === "error") throw new SlackApiError("chat.postMessage", "internal_error");
      if (how === "unknown-not-sent") throw new SlackUnknownOutcomeError("chat.postMessage", new Error("timeout"));
      const ts = `17314001${String(++n).padStart(2, "0")}.000100`;
      thread.push({ ts, text: message.text, marker: message.marker, channel: post.channelId });
      // Posted, but the answer never came back.
      if (how === "lost") throw new SlackUnknownOutcomeError("chat.postMessage", new Error("timeout"));
      return ts;
    },
    react: async (_post, ts, name) => {
      reactions.push(`${ts}:${name}`);
    },
    markers: async () => {
      if (state.markers === "throws") throw new SlackApiError("conversations.replies", "internal_error");
      return { markers: new Map(thread.map((m) => [m.marker, m.ts])), complete: state.markers === "ok" };
    },
    progressed: async (_post, p) => {
      progress.push(p);
    },
  };
  return { deps, thread, reactions, progress, state };
}

test("a reply goes as its chunks, in order, each with its marker", async () => {
  const s = slack();
  const outcome = await deliverPost(claimed(), s.deps);
  assert.equal(outcome.status, "sent");
  assert.deepEqual(s.thread.map((m) => [m.text, m.marker]), [
    ["one", "reply:m1:1731400000.000100:k:a#0"],
    ["two", "reply:m1:1731400000.000100:k:a#1"],
    ["three", "reply:m1:1731400000.000100:k:a#2"],
  ]);
  assert.deepEqual(s.progress, [1, 2, 3]);
});

test("rechecked before it goes: off call, rebound, muted, shared since, or the requester's access gone drops it", async () => {
  const cases: [string, (s: ReturnType<typeof slack>) => void, RegExp][] = [
    ["unbound", (s) => (s.state.binding = null), /no longer on call/],
    ["rebound, same channel", (s) => (s.state.binding = { ...binding, revision: "rev2" }), /another binding/],
    ["rebound elsewhere", (s) => (s.state.binding = { ...binding, channelId: "C2", revision: "rev2" }), /another binding/],
    ["muted", (s) => (s.state.muted = true), /muted/],
    ["shared since", (s) => (s.state.shared = true), /shared outside the workspace/],
    ["access", (s) => s.state.readers.delete("ana"), /can no longer read/],
  ];
  for (const [name, change, why] of cases) {
    const s = slack();
    change(s);
    const outcome = await deliverPost(claimed(), s.deps);
    assert.equal(outcome.status, "dropped", name);
    assert.match(outcome.status === "dropped" ? outcome.error : "", why, name);
    assert.equal(s.thread.length, 0, `${name}: nothing posted, and never to the new channel`);
  }
  // Slack can't say whether it's shared: not posted, and not dropped either.
  // deliverPost throws, and deliverPosts makes that a retry.
  const unsure = slack();
  unsure.state.shared = "unknown";
  await assert.rejects(deliverPost(claimed(), unsure.deps));
  assert.equal(unsure.thread.length, 0);
  // Paused isn't checked: a paused Mission still reports on its work.
  const paused = slack();
  paused.state.binding = { ...binding, paused: true };
  assert.equal((await deliverPost(claimed(), paused.deps)).status, "sent");
});

test("a crash after the second chunk resumes at the third", async () => {
  const s = slack();
  // The first try posted two chunks and recorded them, then died.
  s.thread.push({ ts: "1731400090.000100", text: "one", marker: chunkMarker("reply:m1:1731400000.000100:k:a", 0), channel: "C1" });
  s.thread.push({ ts: "1731400091.000100", text: "two", marker: chunkMarker("reply:m1:1731400000.000100:k:a", 1), channel: "C1" });
  const outcome = await deliverPost(claimed({ attempt: 2, progress: 2, postedTs: ["1731400090.000100", "1731400091.000100"] }), s.deps);
  assert.equal(outcome.status, "sent");
  assert.deepEqual(s.thread.map((m) => m.text), ["one", "two", "three"]);
});

test("a send that went unanswered but posted is found in the thread, not posted again", async () => {
  const s = slack();
  s.state.sends = ["ok", "lost"];
  const first = await deliverPost(claimed(), s.deps);
  assert.equal(first.status, "retry");
  assert.ok(first.status === "retry" && first.inDoubt && first.progress === 1);
  // Next try: the lost chunk is in the thread; it goes on from there.
  const second = await deliverPost(claimed({ attempt: 2, inDoubt: true, progress: 1, postedTs: first.status === "retry" ? first.postedTs : [] }), s.deps);
  assert.equal(second.status, "sent");
  assert.deepEqual(s.thread.map((m) => m.text), ["one", "two", "three"], "chunk two posted once");
  assert.equal(second.status === "sent" && second.postedTs.length, 3);
});

test("a send that went unanswered and didn't post is posted, once the whole thread shows it isn't there", async () => {
  const s = slack();
  s.state.sends = ["unknown-not-sent"];
  const first = await deliverPost(claimed({ payload: { chunks: ["only"] } }), s.deps);
  assert.ok(first.status === "retry" && first.inDoubt);
  const second = await deliverPost(claimed({ payload: { chunks: ["only"] }, attempt: 2, inDoubt: true }), s.deps);
  assert.equal(second.status, "sent");
  assert.deepEqual(s.thread.map((m) => m.text), ["only"]);
});

test("in doubt, and the thread can't settle it: ambiguous, never posted blindly", async () => {
  for (const markers of ["throws", "incomplete"] as const) {
    const s = slack();
    s.state.markers = markers;
    const outcome = await deliverPost(claimed({ payload: { chunks: ["only"] }, attempt: 2, inDoubt: true }), s.deps);
    assert.equal(outcome.status, "ambiguous", markers);
    assert.equal(s.thread.length, 0, markers);
  }
  // Out of tries with the last send unanswered: ambiguous, not "failed".
  const s = slack();
  s.state.sends = ["unknown-not-sent"];
  assert.equal((await deliverPost(claimed({ attempt: MAX_POST_ATTEMPTS }), s.deps)).status, "ambiguous");
});

test("Slack's rate limit waits its Retry-After; other errors back off; refusals for good fail at once", async () => {
  const limited = slack();
  limited.state.sends = ["ratelimited"];
  const wait = await deliverPost(claimed(), limited.deps);
  assert.ok(wait.status === "retry" && wait.delaySeconds === 42 && !wait.inDoubt);
  const flaky = slack();
  flaky.state.sends = ["error"];
  const backoff = await deliverPost(claimed({ attempt: 3 }), flaky.deps);
  assert.ok(backoff.status === "retry" && backoff.delaySeconds === backoffSeconds(3));
  assert.deepEqual([1, 2, 3, 6, 9, 20].map(backoffSeconds), [15, 30, 60, 480, 600, 600]);
  const gone = slack();
  gone.state.sends = ["fatal"];
  assert.equal((await deliverPost(claimed(), gone.deps)).status, "failed");
  const tired = slack();
  tired.state.sends = ["error"];
  assert.equal((await deliverPost(claimed({ attempt: MAX_POST_ATTEMPTS }), tired.deps)).status, "failed");
});

test("a reaction is retried, never in doubt; a question card records its message", async () => {
  const s = slack();
  const reaction = await deliverPost(claimed({ kind: "reaction", payload: { ts: "1731400000.000100", name: "eyes" } }), s.deps);
  assert.equal(reaction.status, "sent");
  assert.deepEqual(s.reactions, ["1731400000.000100:eyes"]);
  const asked: string[] = [];
  s.deps.askPosted = async (askId, ts) => {
    asked.push(`${askId}@${ts}`);
  };
  const card = await deliverPost(claimed({ kind: "ask", payload: { text: "Which?", blocks: [{ type: "section" }], askId: "a1" } }), s.deps);
  assert.equal(card.status, "sent");
  assert.deepEqual(asked, [`a1@${s.thread[0].ts}`]);
});
