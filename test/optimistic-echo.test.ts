import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorPending, livePrompts, pendingAfterStop, pendingShows, promptLanded, settlePending, type PendingPrompt } from "@/lib/session/optimistic-echo";

const typed = (id: string): PendingPrompt => ({ id, text: id, expect: null });

test("a prompt not handed over yet shows however much history lands", () => {
  // The case that matters: typed while the session connects, so nothing of the
  // conversation had arrived; the history then streams in behind it.
  const pending = [typed("a")];
  assert.equal(pendingShows(pending[0], 0), true);
  assert.equal(pendingShows(pending[0], 5), true);
  assert.deepEqual(livePrompts(pending, 5), pending);
});

test("anchoring counts the history that landed while the session connected", () => {
  // Sent at 0 prompts seen, attached with 5 already in the transcript: it waits
  // for the 6th, its own, not for a count it has already passed.
  assert.deepEqual(anchorPending([typed("a")], "a", 5), [{ id: "a", text: "a", expect: 6 }]);
});

test("an anchored prompt goes once the stream records its turn", () => {
  const [anchored] = anchorPending([typed("a")], "a", 5);
  assert.equal(pendingShows(anchored, 5), true);
  assert.equal(pendingShows(anchored, 6), false);
  assert.deepEqual(livePrompts([anchored], 6), []);
});

test("queued prompts keep their order, and caught-up ones go", () => {
  const first = anchorPending([typed("a")], "a", 5);
  const queued = [...first, typed("b")];
  assert.deepEqual(anchorPending(queued, "b", 5), [
    { id: "a", text: "a", expect: 6 },
    { id: "b", text: "b", expect: 7 },
  ]);
  // Once the stream has recorded a's turn, anchoring b drops a.
  assert.deepEqual(anchorPending(queued, "b", 6), [{ id: "b", text: "b", expect: 7 }]);
});

test("a prompt the stream recorded before the session answered goes at once", () => {
  // A new session's first prompt: handed over at 0, and Claude's copy of it
  // streamed back before the POST returned. Anchored at 1, it would wait for a
  // second prompt and show twice until then.
  assert.deepEqual(settlePending([typed("a")], "a", ["a"], 0), []);
});

test("a prompt not recorded yet is anchored past what has been", () => {
  assert.deepEqual(settlePending([typed("a")], "a", ["x", "y"], 1), [{ id: "a", text: "a", expect: 3, sentAt: 1 }]);
});

test("the same text earlier in the history isn't taken for the prompt", () => {
  // "a" was asked before; this "a" was handed over after it, at 1.
  assert.deepEqual(settlePending([typed("a")], "a", ["a"], 1), [{ id: "a", text: "a", expect: 2, sentAt: 1 }]);
});

test("settling one bubble keeps the others queued behind it", () => {
  const pending = [typed("a"), typed("b")];
  assert.deepEqual(settlePending(pending, "a", ["a"], 0), [typed("b")]);
});

test("a confirmed stop lets go of bubbles the session took but never recorded", () => {
  // A prompt sent mid-turn, taken (anchored), then handed back to Claude's
  // input by the stop: the stream never records it.
  const pending: PendingPrompt[] = [
    { id: "taken", text: "and the docs", expect: 3 },
    { id: "going", text: "one more thing", expect: null },
  ];
  const delivered = 2;
  const working = (p: PendingPrompt[]) => p.some((x) => pendingShows(x, delivered));
  assert.equal(working(pending.slice(0, 1)), true, "before the stop, the bubble keeps the page working");
  const after = pendingAfterStop(pending);
  // One still on its way to the session keeps its bubble.
  assert.deepEqual(after.map((p) => p.id), ["going"]);
  assert.equal(working(pendingAfterStop(pending.slice(0, 1))), false);
});

// Reproduced on a box at 4% of a CPU: two prompts typed into Claude's box
// before it took either were recorded as one, 14 blank lines between them.
test("two prompts recorded as one put both bubbles away", () => {
  const merged = ["MSG1", "MSG2", `MSG3 do the needful${"\n".repeat(14)}MSG4 whats happening`];
  let pending: PendingPrompt[] = [{ id: "3", text: "MSG3 do the needful", expect: null }];
  pending = settlePending(pending, "3", ["MSG1", "MSG2"], 2);
  pending = [...pending, { id: "4", text: "MSG4 whats happening", expect: null }];
  pending = settlePending(pending, "4", ["MSG1", "MSG2"], 2);
  assert.deepEqual(livePrompts(pending, merged.length, merged), []);
});

test("a bubble handed over goes as soon as a prompt recorded since holds its words, before the session answers", () => {
  // The half-second double: the stream recorded it while the send was still being answered.
  const inFlight: PendingPrompt = { id: "a", text: "are they ready for PR", expect: null, sentAt: 4 };
  assert.equal(pendingShows(inFlight, 5, ["w", "x", "y", "z", "are they ready for PR"]), false);
  // Not handed over yet (no sentAt): it shows however much history lands.
  assert.equal(pendingShows({ ...inFlight, sentAt: undefined }, 5, ["w", "x", "y", "z", "are they ready for PR"]), true);
});

test("the same words before the bubble was handed over don't put it away", () => {
  const p: PendingPrompt = { id: "a", text: "fix it", expect: 3, sentAt: 2 };
  assert.equal(promptLanded(p, ["fix it", "other"]), false);
  assert.equal(pendingShows(p, 2, ["fix it", "other"]), true);
  // A prompt wrapped around it (a chat's, a Codex plan's) still holds it.
  assert.equal(promptLanded(p, ["fix it", "other", "[Plan first]\nfix it"]), true);
});
