import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { conversationNodes, thoughtSeconds } from "@/lib/runtime/conversation-nodes";

function message(role: "user" | "assistant", timestamp: string, content: ContentBlock[]): AgentEvent {
  return { t: "message", uuid: `${role}-${timestamp}`, parentUuid: null, role, timestamp, content };
}

test("each step is a row, a tool's result riding on its call", () => {
  const nodes = conversationNodes([
    message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "fix it" }]),
    message("assistant", "2026-10-21T10:00:09Z", [{ type: "thinking" }]),
    message("assistant", "2026-10-21T10:00:10Z", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } },
    ]),
    message("user", "2026-10-21T10:00:11Z", [{ type: "tool_result", toolUseId: "t1", content: "a.ts" }]),
    message("assistant", "2026-10-21T10:00:12Z", [{ type: "text", text: "done" }]),
  ]);
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["prompt", "thought", "tool", "tool", "prose"],
  );
  const [, thought, ran, read] = nodes;
  assert.equal(thought.kind === "thought" && thought.seconds, 9);
  assert.deepEqual(ran.kind === "tool" && ran.result, { content: "a.ts" });
  // Still running (or interrupted): no result yet.
  assert.equal(read.kind === "tool" && read.result, null);
});

test("a result that answers no call in the stream is not a row", () => {
  const nodes = conversationNodes([
    message("user", "2026-10-21T10:00:00Z", [{ type: "tool_result", toolUseId: "gone", content: "x" }]),
  ]);
  assert.deepEqual(nodes, []);
});

test("a thought's length needs both times, a second or more, running forwards", () => {
  assert.equal(thoughtSeconds(null, "2026-10-21T10:00:09Z"), null);
  assert.equal(thoughtSeconds("2026-10-21T10:00:00Z", "2026-10-21T10:00:00.400Z"), null);
  assert.equal(thoughtSeconds("2026-10-21T10:00:09Z", "2026-10-21T10:00:00Z"), null);
  assert.equal(thoughtSeconds("not a time", "2026-10-21T10:00:00Z"), null);
  assert.equal(thoughtSeconds("2026-10-21T10:00:00Z", "2026-10-21T10:00:16.6Z"), 17);
});
