import assert from "node:assert/strict";
import { test } from "node:test";

import { CloudLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { resumeFailure } from "@/lib/session/resume-failure";
import { BOX_GONE, BOX_RESTORE_FAILED } from "@/lib/session/session-codes";

test("a paused box that didn't come back offers Try again, not Check Outrunner's setup", () => {
  // Daytona refusing the start, or the agent not booting on the box.
  const failed = resumeFailure(new Error("failed to resolve container IP after 3 attempts"), "box");
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, BOX_RESTORE_FAILED);
  assert.match(failed.body.error, /Try again/);
  assert.doesNotMatch(failed.body.error, /container IP|setup/, "the provider's own error isn't the user's to read");
});

test("the plan refusing the box's start says so, with where to upgrade", () => {
  const denial = { error: "Your plan's cloud hours are used up.", settingsHref: UPGRADE_HREF } as const;
  assert.deepEqual(resumeFailure(new CloudLimitError(denial), "box"), { status: 403, body: denial });
  // The claim's own refusal, from a start that lost the last slot.
  const capped = Object.assign(new Error("Your plan runs 1 box at a time."), { code: "P4BX1" });
  assert.deepEqual(resumeFailure(capped, "box"), {
    status: 403,
    body: { error: "Your plan runs 1 box at a time.", settingsHref: UPGRADE_HREF },
  });
});

test("a box started in place of a deleted one points at a new session", () => {
  const unknown = new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" });
  const gone = resumeFailure(unknown, "relaunch");
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, BOX_GONE);
  assert.match(gone.body.error, /Start a new session/);
});

test("a sign-in to fix answers as before, and anything else is the resume's own failure", () => {
  const outdated = resumeFailure(new OutdatedComputerError("This box's agent is too old to run Codex."), "relaunch");
  assert.deepEqual(outdated, { status: 409, body: { error: "This box's agent is too old to run Codex." } });
  const other = resumeFailure(new AgentRequestError(500, { code: "INTERNAL", message: "tmux exited" }), "relaunch");
  assert.equal(other.status, 502);
  assert.equal(other.body.code, undefined);
});
