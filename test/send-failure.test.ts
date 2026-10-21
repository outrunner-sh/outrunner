import assert from "node:assert/strict";
import { test } from "node:test";

import { SEND_FAILED, sendFailureMessage } from "@/lib/session/send-failure";

test("a send held back for Claude's question says so, as a sentence", () => {
  assert.equal(
    sendFailureMessage(
      "Claude is waiting for an answer in the terminal (a question or a permission prompt). Answer it there, then send again",
    ),
    "Claude is waiting for an answer in the terminal (a question or a permission prompt). Answer it there, then send again.",
  );
});

test("the agent's internals never reach the composer", () => {
  assert.equal(sendFailureMessage("jcode: no session for workspace 6f1c"), SEND_FAILED);
  assert.equal(sendFailureMessage("prompt not confirmed delivered after 3 attempts"), SEND_FAILED);
  assert.equal(sendFailureMessage("exit status 1"), SEND_FAILED);
  assert.equal(sendFailureMessage(undefined), SEND_FAILED);
  assert.equal(sendFailureMessage(""), SEND_FAILED);
});
