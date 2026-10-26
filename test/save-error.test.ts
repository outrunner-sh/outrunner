import assert from "node:assert/strict";
import { test } from "node:test";

import { saveOutcome, type SaveFailure } from "@/lib/settings/save-error";

test("a change that lands clears its own failure, and only its own", () => {
  const token: SaveFailure = { verb: "save", subject: "the Modal token", message: "Modal didn't accept this token." };
  // The same thing saved again: its failure is gone.
  assert.equal(saveOutcome(token, { subject: "the Modal token", ok: true }), null);
  // So did removing it: the token just changed, so the failed save no longer
  // describes what's there.
  assert.equal(saveOutcome(token, { verb: "remove", subject: "the Modal token", ok: true }), null);
  // A different change saved: the token still isn't.
  assert.equal(saveOutcome(token, { subject: "the new box size", ok: true }), token);
  // Nothing had failed; nothing does now.
  assert.equal(saveOutcome(null, { subject: "the new box size", ok: true }), null);
});

test("a change that fails is the line to show", () => {
  assert.deepEqual(saveOutcome(null, { subject: "the new box size", ok: false, message: "The plan doesn't allow it." }), {
    verb: "save",
    subject: "the new box size",
    message: "The plan doesn't allow it.",
  });
  // A removal is called one, and falls back to the same quiet why. The line
  // already says "Couldn't", so the why doesn't say it again.
  assert.deepEqual(saveOutcome(null, { verb: "remove", subject: "the Modal token", ok: false }), {
    verb: "remove",
    subject: "the Modal token",
    message: "Outrunner didn't say why.",
  });
  // It replaces a failure from before it: the latest answer is the one on screen.
  assert.deepEqual(
    saveOutcome({ verb: "save", subject: "the Modal token", message: "rejected." }, { subject: "the new box size", ok: false }),
    { verb: "save", subject: "the new box size", message: "Outrunner didn't say why." },
  );
});
