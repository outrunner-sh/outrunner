import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { claudeIsWorking } from "@/lib/runtime/conversation-events";

const at = "2026-10-27T10:00:00Z";
const prompt: AgentEvent = { t: "message", uuid: "u1", parentUuid: null, role: "user", timestamp: at, content: [{ type: "text", text: "fix it" }] };
const said = (content: ContentBlock[], stopReason?: string): AgentEvent => ({
  t: "message",
  uuid: `a-${content.length}-${stopReason}`,
  parentUuid: null,
  role: "assistant",
  timestamp: at,
  content,
  ...(stopReason && { stopReason }),
});

test("Claude's words before a tool call don't end its turn", () => {
  // Logged as a record of its own, the call still to come.
  assert.equal(claudeIsWorking([prompt, said([{ type: "text", text: "Checking the tests." }], "tool_use")]), true);
  assert.equal(claudeIsWorking([prompt, said([{ type: "text", text: "Done." }], "end_turn")]), false);
});

test("without a stop reason (an older agent, Codex), words end the turn as before", () => {
  assert.equal(claudeIsWorking([prompt, said([{ type: "text", text: "Done." }])]), false);
  assert.equal(claudeIsWorking([prompt, said([{ type: "tool_use", id: "t1", name: "Bash", input: {} }])]), true);
  assert.equal(claudeIsWorking([prompt]), true);
});
