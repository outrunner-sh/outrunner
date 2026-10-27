import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import {
  conversationNodes,
  conversationTurns,
  currentTurn,
  plainText,
  thoughtSeconds,
} from "@/lib/runtime/conversation-nodes";

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

test("a stopped turn shows as one row, not as the user's prompt", () => {
  const nodes = conversationNodes([
    message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "fix it" }]),
    message("assistant", "2026-10-21T10:00:05Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    message("user", "2026-10-21T10:00:06Z", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
  ]);
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["prompt", "tool", "interrupted"],
  );
});

test("a turn is a prompt and Claude's last words in it, as plain text", () => {
  const turns = conversationTurns(
    conversationNodes([
      { t: "state", state: "running" },
      message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "study the **API**" }]),
      message("assistant", "2026-10-21T10:00:05Z", [{ type: "text", text: "Looking." }]),
      message("assistant", "2026-10-21T10:00:06Z", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      message("assistant", "2026-10-21T10:00:09Z", [{ type: "text", text: "## Done\n- see [notes](https://x)" }]),
      message("user", "2026-10-21T10:01:00Z", [{ type: "text", text: "ship it" }]),
    ] as AgentEvent[]),
  );
  assert.deepEqual(
    turns.map(({ prompt, reply }) => ({ prompt, reply })),
    [
      // The last words, not the first; the state before any prompt is no turn.
      { prompt: "study the API", reply: "Done see notes" },
      // Nothing said yet.
      { prompt: "ship it", reply: null },
    ],
  );
});

test("a preview drops markdown's marks and code fences, and runs whitespace together", () => {
  assert.equal(plainText("1. Paste `a.sql`\n```sql\nselect 1;\n```\n> _then_ ~~not~~ run"), "Paste a.sql select 1; then not run");
  assert.equal(plainText("   "), "");
});

test("the turn read is the last whose prompt reached the reading line, else the first", () => {
  assert.equal(currentTurn([], 100), -1);
  assert.equal(currentTurn([40, 500, 900], 10), 0);
  assert.equal(currentTurn([40, 500, 900], 500), 1);
  assert.equal(currentTurn([40, 500, 900], 5000), 2);
});
