import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalRuntimeError, localSendFailure } from "@/lib/desktop/local-runtime";
import { SEND_FAILED, sendFailureMessage, sendIsDeadEnd } from "@/lib/session/send-failure";

test("a send whose box is gone is a dead end, not something to retry", () => {
  // The message route's tag for it; the composer drops Retry for these.
  assert.equal(sendIsDeadEnd("box-gone"), true);
  for (const other of [null, undefined, "", "box-restore-failed", "agent-did-not-start"]) {
    assert.equal(sendIsDeadEnd(other), false, String(other));
  }
});

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

test("a local send's failure is a sentence, whatever the agent said", () => {
  // An agent refusal goes through the same filter as a hosted send's.
  assert.equal(
    localSendFailure(
      new LocalRuntimeError(
        "It didn't go.",
        "agent",
        "Claude is waiting for an answer in the terminal (a question or a permission prompt). Answer it there, then send again",
      ),
    ),
    "Claude is waiting for an answer in the terminal (a question or a permission prompt). Answer it there, then send again.",
  );
  assert.equal(localSendFailure(new LocalRuntimeError("It didn't go.", "agent", "jcode: no session for workspace 6f1c")), SEND_FAILED);
  // The app's own errors are already sentences; a session that's gone keeps
  // its message rather than the agent's reason.
  assert.equal(localSendFailure(new LocalRuntimeError("The Outrunner app isn't running.", null, null)), "The Outrunner app isn't running.");
  assert.equal(
    localSendFailure(new LocalRuntimeError("This session isn't running on its computer any more.", "agent", "unknown workspace")),
    "This session isn't running on its computer any more.",
  );
  // Anything else is a send that didn't go.
  assert.equal(localSendFailure(new TypeError("Load failed")), SEND_FAILED);
});
