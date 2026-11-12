import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { claudeIsWorking } from "@/lib/runtime/conversation-events";
import { parseConversation } from "@/lib/runtime/replay/conversation";

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

test("a stopped Codex turn reads as stopped once the agent records the stop", () => {
  // The real translated rollout, cut where its third turn was stopped: Codex
  // wrote the prompt and its reasoning, and nothing of the stop.
  const translated = readFileSync(
    fileURLToPath(new URL("../runtime-agent/internal/codex/testdata/rollout.translated.jsonl", import.meta.url)),
    "utf8",
  );
  const lines = translated.split("\n");
  const next = lines.findIndex((line) => line.includes("Reply with the word resumed."));
  const stoppedTurn = parseConversation(lines.slice(0, next).join("\n"));
  assert.equal(claudeIsWorking(stoppedTurn), true, "without a record of the stop, the turn looks to be going");
  // What the agent appends once Codex has stopped (codexTail.interrupted).
  const stop =
    '{"type":"user","uuid":"interrupted-1","parentUuid":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}';
  assert.equal(claudeIsWorking(parseConversation([...lines.slice(0, next), stop].join("\n"))), false);
});

test("Codex commentary remains working in the live stream and after replay", () => {
  assert.equal(claudeIsWorking([prompt, said([{ type: "text", text: "Still working." }], "in_progress")]), true);
  const translated = readFileSync(new URL("../runtime-agent/internal/codex/testdata/rollout.translated.jsonl", import.meta.url), "utf8");
  const lines = translated.trim().split("\n");
  const commentary = lines.findIndex((line) => line.includes('"stop_reason":"in_progress"') && line.includes('"type":"text"'));
  assert.ok(commentary >= 0, "real Codex fixture contains commentary");
  assert.equal(claudeIsWorking(parseConversation(lines.slice(0, commentary + 1).join("\n"))), true);
  assert.equal(claudeIsWorking(parseConversation(translated)), false, "final answer ends the turn");
});

test("/context's report ends the turn: Claude Code printed it, nothing answers it", () => {
  // Claude Code 2.1.304 logs /context as two system records (not decoded) and
  // the report as a meta record, for the model to read later.
  const line = (rec: object) => JSON.stringify(rec);
  const events = parseConversation(
    [
      line({ type: "system", subtype: "local_command", uuid: "s1", parentUuid: null, timestamp: at, content: "<command-name>/context</command-name>" }),
      line({ type: "system", subtype: "local_command", uuid: "s2", parentUuid: "s1", timestamp: at, content: "<local-command-stdout> \u001b[1mContext Usage\u001b[22m</local-command-stdout>" }),
      line({
        type: "user",
        uuid: "m1",
        parentUuid: "s2",
        timestamp: at,
        isMeta: true,
        message: { role: "user", content: "## Context Usage\n\n**Model:** claude-sonnet-5-5  \n**Tokens:** 29.1k / 1m (3%)\n" },
      }),
    ].join("\n"),
  );
  assert.equal(events.length, 1, "only the report reaches the timeline");
  assert.equal(claudeIsWorking(events), false);
  // A skill's instructions are meta too, and answered.
  const skill: AgentEvent = { ...prompt, uuid: "m2", meta: true, content: [{ type: "text", text: "Base directory for this skill: /work/skill" }] };
  assert.equal(claudeIsWorking([skill]), true);
});
