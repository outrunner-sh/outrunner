import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { ASK_TOOL } from "@/lib/runtime/pending-question";
import { SECRETS_TOOL } from "@/lib/runtime/pending-secrets";
import { foldEvents, IDLE, isErrorPreview, preview, shownPreview } from "@/lib/session/turn-state";

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

test("a turn that ends in an API error is kept as one: a reply whose preview is marked so", () => {
  const synthetic = (text: string, minute: number): AgentEvent =>
    ({ ...reply(text, minute, "stop_sequence"), model: "<synthetic>" }) as AgentEvent;
  const failed = foldEvents(IDLE, [user("Describe the image", 1), synthetic("API Error: 400 image input is not supported", 2)]);
  assert.equal(failed.turn, "idle");
  assert.equal(failed.repliedAt, at(2));
  assert.equal(isErrorPreview(failed.replyPreview), true);
  // The mark is no display text: what shows reads as Claude Code wrote it.
  assert.equal(shownPreview(failed.replyPreview), "API Error: 400 image input is not supported");
  // Claude Code's other failures are marked too, a usage limit's reset said, not a raw timestamp.
  const limited = foldEvents(IDLE, [user("Go on", 1), synthetic("Claude AI usage limit reached|1761746400", 2)]);
  assert.equal(isErrorPreview(limited.replyPreview), true);
  assert.equal(shownPreview(limited.replyPreview), "Claude AI usage limit reached, resets 2025-10-29 14:00 UTC");
  // Its "No response requested." is no failure, and a model's reply is none,
  // whatever its words: one that starts "API Error" isn't taken for one.
  assert.equal(isErrorPreview(foldEvents(IDLE, [user("hi", 1), synthetic("No response requested.", 2)]).replyPreview), false);
  const answered = foldEvents(IDLE, [user("hi", 1), reply("API Error: 400 is what the endpoint returns for a bad id.", 2)]);
  assert.equal(isErrorPreview(answered.replyPreview), false);
  assert.equal(shownPreview(answered.replyPreview), "API Error: 400 is what the endpoint returns for a bad id.");
});

test("Claude Code's \"No response requested.\" after a restart ends the turn, but is no reply to keep or notify of", () => {
  const working = foldEvents(IDLE, [user("build it", 0), reply("Done earlier.", 1), user("now test it", 2), call("Bash", "t9", 3)]);
  assert.equal(working.turn, "working");
  // The agent was killed mid-call; started again, Claude Code closes the call
  // and stands in for the reply (Claude Code 2.1.310, reproduced).
  const cutOff: AgentEvent = {
    t: "message", uuid: `r${n++}`, parentUuid: null, role: "user", timestamp: at(9),
    content: [{ type: "tool_result", toolUseId: "t9", content: "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]" }],
  };
  const standIn: AgentEvent = {
    t: "message", uuid: `a${n++}`, parentUuid: null, role: "assistant", model: "<synthetic>", stopReason: "stop_sequence",
    timestamp: at(9), content: [{ type: "text", text: "No response requested." }],
  };
  const after = foldEvents(working, [cutOff, standIn]);
  assert.equal(after.turn, "idle");
  assert.equal(after.repliedAt, working.repliedAt);
  assert.equal(after.replyPreview, "Done earlier.");
});
