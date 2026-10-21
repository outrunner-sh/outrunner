import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorPending, livePrompts, pendingShows, type PendingPrompt } from "@/lib/session/optimistic-echo";

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
