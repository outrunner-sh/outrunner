import assert from "node:assert/strict";
import { test } from "node:test";

import { followsAfterScroll } from "@/lib/session/follow-scroll";

// A 600px view on 5,000px of conversation.
const view = { viewHeight: 600, scrollHeight: 5_000 };

test("a jump to the end that history outgrew keeps following", () => {
  // Jumped to the old end (1,400 of 2,000), then 3,000px more landed before
  // the scroll event: far from the new end, but nothing the user did.
  assert.equal(followsAfterScroll({ ...view, following: true, byUser: false, top: 1_400, lastTop: 0 }), true);
});

test("rows rendering above can move the view up without stopping the follow", () => {
  assert.equal(followsAfterScroll({ ...view, following: true, byUser: false, top: 1_300, lastTop: 1_400 }), true);
});

test("the user scrolling up stops it, and back to the end starts it again", () => {
  const up = followsAfterScroll({ ...view, following: true, byUser: true, top: 1_000, lastTop: 4_400 });
  assert.equal(up, false);
  // Scrolling down short of the end keeps reading where they are.
  assert.equal(followsAfterScroll({ ...view, following: up, byUser: true, top: 3_000, lastTop: 1_000 }), false);
  // Within reach of the end: following again, whoever scrolled.
  assert.equal(followsAfterScroll({ ...view, following: false, byUser: false, top: 4_350, lastTop: 3_000 }), true);
});

test("a hidden panel says nothing about where the user is", () => {
  const hidden = { viewHeight: 0, scrollHeight: 0, top: 0, lastTop: 4_400, byUser: true };
  assert.equal(followsAfterScroll({ ...hidden, following: false }), false);
  assert.equal(followsAfterScroll({ ...hidden, following: true }), true);
});

test("a jump back to an earlier turn doesn't count its first frames as a return to the end", () => {
  // Still within reach of the end as the smooth scroll starts.
  assert.equal(followsAfterScroll({ ...view, following: false, byUser: false, jumping: true, top: 4_350, lastTop: 4_400 }), false);
  // Landed on that turn: reading there.
  assert.equal(followsAfterScroll({ ...view, following: false, byUser: false, top: 1_200, lastTop: 1_300 }), false);
});
