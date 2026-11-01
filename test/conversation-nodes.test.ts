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
import { echoUuid } from "@/lib/session/optimistic-echo";
import { promptWithAttachments } from "@/lib/runtime/attachments";

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
    ["prompt", "thought", "tool", "tool", "prose", "worked"],
  );
  const [, thought, ran, read] = nodes;
  assert.equal(thought.kind === "thought" && thought.seconds, 9);
  assert.deepEqual(ran.kind === "tool" && ran.result, { content: "a.ts" });
  // Still running (or interrupted): no result yet.
  assert.equal(read.kind === "tool" && read.result, null);
});

test("a failed tool's result says so (NEE-234)", () => {
  const nodes = conversationNodes([
    message("assistant", "2026-10-21T10:00:10Z", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "true" } },
    ]),
    message("user", "2026-10-21T10:00:11Z", [
      { type: "tool_result", toolUseId: "t1", content: "Exit code 1", isError: true },
      { type: "tool_result", toolUseId: "t2", content: "", isError: false },
    ]),
  ]);
  const [failed, passed] = nodes;
  assert.deepEqual(failed.kind === "tool" && failed.result, { content: "Exit code 1", isError: true });
  assert.deepEqual(passed.kind === "tool" && passed.result, { content: "" });
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
    ["prompt", "tool", "interrupted", "worked"],
  );
});

test("a session's start shows until its first message, not after", () => {
  const starting = { t: "state", workspaceId: "w", state: "starting" } as AgentEvent;
  assert.deepEqual(
    conversationNodes([starting]).map((n) => n.kind),
    ["state"],
  );
  // The prompt went in and Claude answered: the session is running, though
  // the agent sent no state to say so.
  const nodes = conversationNodes([
    starting,
    message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "fix it" }]),
    message("assistant", "2026-10-21T10:00:05Z", [{ type: "text", text: "Done." }]),
  ]);
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["prompt", "prose", "worked"],
  );
  // The echo of a prompt just sent is not the session taking it: still starting.
  const sent = conversationNodes([
    starting,
    { ...message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "fix it" }]), uuid: echoUuid("p1") } as AgentEvent,
  ]);
  assert.deepEqual(
    sent.map((n) => n.kind),
    ["state", "prompt"],
  );
  // Any other state still shows where it is.
  const exited = conversationNodes([
    message("user", "2026-10-21T10:00:00Z", [{ type: "text", text: "fix it" }]),
    { t: "state", workspaceId: "w", state: "exited" },
  ]);
  assert.deepEqual(
    exited.map((n) => n.kind),
    ["prompt", "state"],
  );
});

test("Claude's injected records fold away; the user's prompts stay inline", () => {
  const meta = (text: string, isMeta = false): AgentEvent => ({
    ...message("user", "2026-10-21T10:00:00Z", [{ type: "text", text }]),
    ...(isMeta ? { meta: true } : {}),
  });
  const kindFor = (event: AgentEvent) => {
    const [node] = conversationNodes([event]);
    return node.kind === "meta" ? `meta:${node.label}` : node.kind;
  };
  // Marked meta (a skill's instructions), and the wrappers injected whole.
  assert.equal(kindFor(meta("Base directory for this skill: /x\n\n# hunt", true)), "meta:Skill");
  assert.equal(kindFor(meta("anything at all", true)), "meta:Internal");
  assert.equal(kindFor(meta("<task-notification>\n<task-id>b1</task-id>")), "meta:Background task");
  assert.equal(kindFor(meta("<system-reminder>\nRemember to…")), "meta:System reminder");
  assert.equal(kindFor(meta("<command-name>/loop</command-name>")), "meta:Command");
  // The user's own words stay a prompt — including an attached-file prompt,
  // whose <system_instruction> wrapper leads but whose words follow.
  assert.equal(kindFor(meta("fix the bug")), "prompt");
  assert.equal(kindFor(meta("<system_instruction>\nAttached files.\n</system_instruction>\nfix it")), "prompt");
  // A meta record starts no turn.
  assert.equal(
    conversationTurns(conversationNodes([meta("skill text", true)])).length,
    0,
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
  // Underscores in names stay; only emphasis goes.
  assert.equal(plainText("fix user_turn_count in claude_agent.go, _now_"), "fix user_turn_count in claude_agent.go, now");
});

test("the turn read is the last whose prompt reached the reading line, else the first", () => {
  assert.equal(currentTurn([], 100), -1);
  assert.equal(currentTurn([40, 500, 900], 10), 0);
  assert.equal(currentTurn([40, 500, 900], 500), 1);
  assert.equal(currentTurn([40, 500, 900], 5000), 2);
});

test("the turn rail names a prompt by its words, not the files it carried", () => {
  const turns = conversationTurns(
    conversationNodes([
      message("user", "2026-10-29T10:00:00Z", [{ type: "text", text: promptWithAttachments("what's wrong here?", ["3f2a9c1b-shot.png"]) }]),
      message("assistant", "2026-10-29T10:00:05Z", [{ type: "text", text: "a typo" }]),
      message("user", "2026-10-29T10:01:00Z", [{ type: "text", text: promptWithAttachments("", ["3f2a9c1b-a.png", "8d41e7a0-b.png"]) }]),
      message("assistant", "2026-10-29T10:01:05Z", [{ type: "text", text: "two cats" }]),
      message("user", "2026-10-29T10:02:00Z", [{ type: "text", text: promptWithAttachments("", ["3f2a9c1b-log.txt"]) }]),
    ]),
  );
  assert.deepEqual(
    turns.map((t) => t.prompt),
    ["what's wrong here?", "2 images", "File"],
  );
});

test("an image pasted into the agent's own prompt rides on the prompt's row", () => {
  const nodes = conversationNodes([
    message("user", "2026-10-29T10:00:00Z", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "[Image #1] what is this?" },
    ]),
  ]);
  const prompt = nodes.find((n) => n.kind === "prompt");
  assert.deepEqual(prompt?.kind === "prompt" && prompt.images, [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
});
