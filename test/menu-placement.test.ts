import assert from "node:assert/strict";
import { test } from "node:test";

import { MENU_GAP, placeMenu } from "@/lib/client/menu-placement";

const room = { top: 0, bottom: 718 };

test("a menu opens below its trigger when it fits there", () => {
  assert.deepEqual(placeMenu({ top: 100, bottom: 130 }, room, 420), {
    side: "below",
    maxHeight: 718 - 130 - 2 * MENU_GAP,
  });
});

test("short of room below, it opens above where there is more, no taller than that room", () => {
  // The repository chip in a 718px window, below the middle.
  const placed = placeMenu({ top: 420, bottom: 450 }, room, 420);
  assert.deepEqual(placed, { side: "above", maxHeight: 420 - 2 * MENU_GAP });
});

test("short of room both ways, it takes the side with more, and fits it", () => {
  const placed = placeMenu({ top: 300, bottom: 330 }, { top: 120, bottom: 600 }, 420);
  assert.deepEqual(placed, { side: "below", maxHeight: 600 - 330 - 2 * MENU_GAP });
});

test("the room is what can be seen, not the window: a clipping area's top counts", () => {
  // Room above in the window, but a scroll area starting at 250 clips it.
  const placed = placeMenu({ top: 400, bottom: 430 }, { top: 250, bottom: 718 }, 420);
  assert.equal(placed.side, "below");
  assert.equal(placed.maxHeight, 718 - 430 - 2 * MENU_GAP);
});

test("no room at all gives no height, never a negative one", () => {
  assert.deepEqual(placeMenu({ top: 0, bottom: 10 }, { top: 0, bottom: 10 }, 420), { side: "below", maxHeight: 0 });
});
