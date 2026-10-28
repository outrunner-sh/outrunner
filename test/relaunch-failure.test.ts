import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { relaunchFailure, shownReason } from "@/lib/session/relaunch-failure";
import { BOX_GONE, SESSION_NOT_STARTED } from "@/lib/session/session-codes";

const stopped = async () => false;

test("an agent that didn't start is said, with why, rather than attached as if fine", async () => {
  // Claude exiting at launch, as the agent answers it.
  const exited = new AgentRequestError(500, { code: "INTERNAL", message: "Claude Code exited as soon as it started" });
  assert.deepEqual(await relaunchFailure(exited, stopped), {
    status: 502,
    body: { error: "Its agent didn't start: Claude Code exited as soon as it started", code: SESSION_NOT_STARTED },
  });
  // Something before the agent was asked (a model key that couldn't be read).
  const unread = await relaunchFailure(new Error("OpenRouter 503"), stopped);
  assert.equal(unread?.status, 502);
  assert.equal(unread?.body.code, SESSION_NOT_STARTED);
  assert.doesNotMatch(unread?.body.error ?? "", /OpenRouter/, "a server's own error isn't the user's to read");
});

test("a session running after a hiccup is attached as before", async () => {
  let asked = 0;
  const hiccup = new AgentRequestError(503, { code: "AGENT_UNREACHABLE", message: "its screen could not be read" });
  assert.equal(await relaunchFailure(hiccup, async () => (asked++, true)), null);
  assert.equal(asked, 1);
});

test("a sign-in to fix and a box that's gone answer as they did, without asking the box", async () => {
  let asked = 0;
  const ask = async () => (asked++, false);
  const outdated = await relaunchFailure(new OutdatedComputerError("This box's agent is too old to run Codex."), ask);
  assert.equal(outdated?.status, 409);
  assert.equal(outdated?.body.error, "This box's agent is too old to run Codex.");
  const gone = await relaunchFailure(new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" }), ask);
  assert.equal(gone?.status, 410);
  assert.equal(gone?.body.code, BOX_GONE);
  assert.equal(asked, 0);
});

test("the agent's reason is shown as its first line, cut short", async () => {
  const wrapped = new AgentRequestError(500, {
    code: "INTERNAL",
    message: `tmux new-session ws-1: exit status 1: ${"x".repeat(400)}\nstderr: more of it`,
  });
  const failed = await relaunchFailure(wrapped, async () => false);
  assert.ok(failed && failed.body.error.length <= "Its agent didn't start: ".length + 200);
  assert.doesNotMatch(failed?.body.error ?? "", /stderr/);
  assert.match(failed?.body.error ?? "", /…$/);
  assert.equal(shownReason("  \n"), null);
  assert.equal(shownReason(undefined), null);
  assert.equal(shownReason("Claude Code exited as soon as it started"), "Claude Code exited as soon as it started");
});
