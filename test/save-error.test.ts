import assert from "node:assert/strict";
import { test } from "node:test";

import { saveOutcome } from "@/lib/settings/save-error";

test("a save that lands clears its own failure, and only its own", () => {
  const token = { subject: "the Modal token", message: "Modal didn't accept this token." };
  // The same thing saved again: its failure is gone.
  assert.equal(saveOutcome(token, { subject: "the Modal token", ok: true }), null);
  // A different change saved: the token still isn't.
  assert.equal(saveOutcome(token, { subject: "the switch to Daytona", ok: true }), token);
  // Nothing had failed; nothing does now.
  assert.equal(saveOutcome(null, { subject: "the new box size", ok: true }), null);
});

test("a save that fails is the line to show", () => {
  assert.deepEqual(saveOutcome(null, { subject: "the switch to Modal", ok: false, message: "Modal is unreachable." }), {
    subject: "the switch to Modal",
    message: "Modal is unreachable.",
  });
  // It replaces a failure from before it: the latest answer is the one on screen.
  assert.deepEqual(
    saveOutcome({ subject: "the Modal token", message: "rejected." }, { subject: "the new box size", ok: false }),
    { subject: "the new box size", message: "Couldn't save that. Outrunner didn't say why." },
  );
});
