import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { agentStopped, isBusyRefusal, stoppedDetail, undeliveredPrompts } from "@/lib/session/agent-stopped";

const state = (s: "running" | "exited", reason?: string): AgentEvent =>
  ({ t: "state", workspaceId: "w", state: s, ...(reason && { reason }) }) as AgentEvent;
const said: AgentEvent = {
  t: "message", uuid: "m", parentUuid: null, role: "assistant", timestamp: "2026-11-21T09:10:00Z",
  content: [{ type: "text", text: "Writing the server side now." }],
};

test("an agent is stopped while the stream's word is that it exited, with why", () => {
  assert.equal(agentStopped([said]), null);
  assert.equal(agentStopped([said, state("running")]), null);
  assert.deepEqual(agentStopped([said, state("exited", "out_of_memory")]), { outOfMemory: true });
  assert.deepEqual(agentStopped([said, state("exited")]), { outOfMemory: false });
});

test("what the page says names the box's memory only when that was why", () => {
  assert.match(stoppedDetail({ outOfMemory: true }), /ran out of memory/);
  assert.doesNotMatch(stoppedDetail({ outOfMemory: false }), /memory/);
  assert.match(stoppedDetail({ outOfMemory: false }), /Restart it/);
});

test("prompts handed over but never recorded are the undelivered ones", () => {
  const pending = [
    { id: "a", text: "queued, not handed over", expect: null },
    { id: "b", text: "handed over, recorded", expect: 3 },
    { id: "c", text: "handed over, never recorded", expect: 4 },
  ];
  assert.deepEqual(undeliveredPrompts(pending, 3).map((p) => p.id), ["c"]);
});

test("the box's refusal of an edit mid-turn is told from other failures", () => {
  assert.equal(isBusyRefusal("the agent is working: stop it before editing a message"), true);
  assert.equal(isBusyRefusal("that message isn't one of this chat's prompts"), false);
});
