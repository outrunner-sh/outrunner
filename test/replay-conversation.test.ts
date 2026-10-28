import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { claudeIsWorking, userPrompts } from "@/lib/runtime/conversation-events";
import { parseConversation } from "@/lib/runtime/replay/conversation";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../lib/runtime/replay/conversation.fixtures.json", import.meta.url),
    ),
    "utf8",
  ),
) as { lines: string[]; events: unknown[] };

test("parseConversation matches the shared Go/TS golden fixture", () => {
  const events = parseConversation(fixture.lines.join("\n"));
  assert.deepEqual(events, fixture.events);
});

test("parseConversation tolerates malformed, empty, and app-internal records", () => {
  const jsonl = [
    "not json",
    "",
    "   ",
    '{"type":"system","uuid":"s","message":{"role":"user","content":[]}}',
    '{"type":"assistant","uuid":"u","message":null}',
    '{"type":"assistant","uuid":"ok","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join("\n");
  const events = parseConversation(jsonl);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    t: "message",
    uuid: "ok",
    parentUuid: null,
    role: "assistant",
    timestamp: "t",
    content: [{ type: "text", text: "hi" }],
  });
});

test("parseConversation captures the assistant model and omits it on user turns", () => {
  const jsonl = [
    '{"type":"assistant","uuid":"a","parentUuid":null,"timestamp":"t","message":{"role":"assistant","model":"claude-opus-4-5-20250115","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"user","uuid":"u","parentUuid":"a","timestamp":"t","message":{"role":"user","content":"yo"}}',
  ].join("\n");
  const [assistant, user] = parseConversation(jsonl) as { model?: string }[];
  assert.equal(assistant.model, "claude-opus-4-5-20250115");
  // Mirrors the Go omitempty: no model key on a user turn (not `undefined`).
  assert.ok(!("model" in user), "user turn should carry no model key");
});

test("parseConversation drops empty/absent protocol fields like the Go omitempty marshaling", () => {
  const jsonl =
    '{"type":"assistant","uuid":"u","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"","id":"","extra":"ignored"}]}}';
  const [event] = parseConversation(jsonl);
  // `text` and `id` are empty -> dropped; `extra` is not a protocol key -> dropped.
  assert.deepEqual((event as { content: unknown[] }).content, [{ type: "text" }]);
});

test("a prompt Claude took in mid-turn is the user's next prompt, and a task notice is not", () => {
  // As Claude Code 2.1.310 wrote it: the prompt typed while a Bash call ran is
  // queued, then joins the turn after that call's result, as an attachment only.
  const jsonl = [
    '{"type":"user","uuid":"p1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":"FIRST run a sleep"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"p1","timestamp":"t2","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"sleep 12"}}]}}',
    '{"type":"queue-operation","operation":"enqueue","timestamp":"t3","content":"SECOND typed mid-turn"}',
    '{"type":"queue-operation","operation":"remove","timestamp":"t4","content":"SECOND typed mid-turn","reason":"absorbed_mid_turn"}',
    '{"type":"user","uuid":"r1","parentUuid":"a1","timestamp":"t4","message":{"role":"user","content":[{"tool_use_id":"tu1","type":"tool_result","content":"slept","is_error":false}]}}',
    '{"type":"attachment","uuid":"q1","parentUuid":"r1","timestamp":"t4","attachment":{"type":"queued_command","prompt":"SECOND typed mid-turn","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true}}',
    '{"type":"attachment","uuid":"q2","parentUuid":"q1","timestamp":"t4","attachment":{"type":"queued_command","prompt":"<task-notification>done</task-notification>","commandMode":"task-notification"}}',
  ].join("\n");
  const events = parseConversation(jsonl);
  assert.deepEqual(userPrompts(events), ["FIRST run a sleep", "SECOND typed mid-turn"]);
  // Claude has the prompt to answer: at work, until its reply.
  assert.equal(claudeIsWorking(events), true);
  const replied = parseConversation(
    `${jsonl}\n{"type":"assistant","uuid":"a2","parentUuid":"q2","timestamp":"t5","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Updated."}]}}`,
  );
  assert.equal(claudeIsWorking(replied), false);
});
