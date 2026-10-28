import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { ASK_TOOL } from "@/lib/runtime/pending-question";
import { SECRETS_TOOL } from "@/lib/runtime/pending-secrets";
import { foldEvents, IDLE, preview } from "@/lib/session/turn-state";

let n = 0;
const at = (minute: number) => `2026-10-28T10:${String(minute).padStart(2, "0")}:00Z`;
const user = (text: string, minute = 0): AgentEvent => ({
  t: "message",
  uuid: `u${n++}`,
  parentUuid: null,
  role: "user",
  timestamp: at(minute),
  content: [{ type: "text", text }],
});
const result = (toolUseId: string, minute = 0): AgentEvent => ({
  t: "message",
  uuid: `r${n++}`,
  parentUuid: null,
  role: "user",
  timestamp: at(minute),
  content: [{ type: "tool_result", toolUseId, content: "ok" }],
});
const reply = (text: string, minute = 0, stopReason = "end_turn"): AgentEvent => ({
  t: "message",
  uuid: `a${n++}`,
  parentUuid: null,
  role: "assistant",
  stopReason,
  timestamp: at(minute),
  content: [{ type: "text", text }],
});
const call = (name: string, id: string, minute = 0): AgentEvent => ({
  t: "message",
  uuid: `c${n++}`,
  parentUuid: null,
  role: "assistant",
  stopReason: "tool_use",
  timestamp: at(minute),
  content: [{ type: "tool_use", id, name, input: {} }],
});

test("a prompt starts a turn and a reply in words ends it, kept as its preview", () => {
  const working = foldEvents(IDLE, [user("Fix the login bug", 1)]);
  assert.equal(working.turn, "working");
  assert.equal(working.turnStartedAt, at(1));
  const done = foldEvents(working, [call("Bash", "t1", 2), result("t1", 3), reply("Fixed it.\n\nThe  token was stale.", 4)]);
  assert.equal(done.turn, "idle");
  assert.equal(done.turnStartedAt, at(1), "the turn's start is kept through its tool calls");
  assert.equal(done.repliedAt, at(4));
  assert.equal(done.replyPreview, "Fixed it. The token was stale.");
});

test("words before a tool call are not the turn's end", () => {
  const state = foldEvents(IDLE, [user("go", 1), reply("Let me look.", 2, "tool_use")]);
  assert.equal(state.turn, "working");
  assert.equal(state.repliedAt, null);
});

test("a question, a plan and a secrets request wait on the user until answered", () => {
  for (const [tool, waiting] of [
    [ASK_TOOL, "question"],
    ["ExitPlanMode", "plan"],
    [SECRETS_TOOL, "secrets"],
  ] as const) {
    const asked = foldEvents(IDLE, [user("go", 1), call(tool, "q1", 2)]);
    assert.equal(asked.waiting, waiting, tool);
    assert.equal(asked.waitingSince, at(2));
    // Another call's result doesn't answer it.
    assert.equal(foldEvents(asked, [result("other", 3)]).waiting, waiting);
    const answered = foldEvents(asked, [result("q1", 3)]);
    assert.equal(answered.waiting, null);
    assert.equal(answered.turn, "working");
  }
});

test("a stop, a new prompt or the session ending is the end of any wait", () => {
  const asked = foldEvents(IDLE, [user("go", 1), call(ASK_TOOL, "q1", 2)]);
  const stopped = foldEvents(asked, [user("[Request interrupted by user]", 3)]);
  assert.deepEqual([stopped.turn, stopped.waiting], ["idle", null]);
  assert.equal(foldEvents(asked, [user("never mind, do this", 3)]).waiting, null);
  const ended = foldEvents(asked, [{ t: "state", workspaceId: "w", state: "exited" }]);
  assert.deepEqual([ended.turn, ended.waiting], ["idle", null]);
});

test("folding in pieces is folding at once", () => {
  const events = [user("go", 1), call("Read", "t1", 2), result("t1", 3), call(ASK_TOOL, "q", 4), result("q", 5), reply("Done", 6)];
  const whole = foldEvents(IDLE, events);
  const pieces = foldEvents(foldEvents(foldEvents(IDLE, events.slice(0, 2)), events.slice(2, 4)), events.slice(4));
  assert.deepEqual(pieces, whole);
});

test("a preview is one line, cut short", () => {
  assert.equal(preview("a\n\nb"), "a b");
  const long = preview("x".repeat(400));
  assert.equal(long.length, 280);
  assert.ok(long.endsWith("…"));
});

test("a /compact at the prompt box leaves the session idle, as a real Claude Code 2.1.304 records it", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseConversation } = await import("@/lib/runtime/replay/conversation");
  const events = parseConversation(
    readFileSync(new URL("../runtime-agent/internal/conversation/testdata/claude-2.1.304.jsonl", import.meta.url), "utf8"),
  );
  // The session ends on /compact: its typed record, the compaction, then the
  // command's own records (caveat, <command-name>, <local-command-stdout>).
  assert.equal(foldEvents(IDLE, events).turn, "idle");
  const compacting = events.findIndex((e) => e.t === "message" && e.compact);
  assert.equal(foldEvents(IDLE, events.slice(0, compacting)).turn, "working", "the typed /compact starts it");
});

test("a compaction mid-turn doesn't end the turn", () => {
  const at = "2026-10-28T10:00:00Z";
  const prompt: AgentEvent = { t: "message", uuid: "p", parentUuid: null, role: "user", timestamp: at, content: [{ type: "text", text: "fix it" }] };
  const compacted = { t: "message", uuid: "c", parentUuid: null, role: "assistant", timestamp: at, content: [], compact: { trigger: "auto" } } as AgentEvent;
  assert.equal(foldEvents(IDLE, [prompt, compacted]).turn, "working");
});

test("a custom command or skill is answered: its record starts a turn, as a prompt does", () => {
  const at = "2026-10-28T10:00:00Z";
  const review = {
    t: "message",
    uuid: "r",
    parentUuid: null,
    role: "user",
    timestamp: at,
    content: [{ type: "text", text: "<command-message>review is running…</command-message>\n<command-name>/review</command-name>" }],
  } as AgentEvent;
  assert.equal(foldEvents(IDLE, [review]).turn, "working");
});
