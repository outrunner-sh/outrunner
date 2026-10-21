import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { toolRow } from "@/lib/runtime/conversation-format";
import {
  ASK_TOOL,
  isAnswered,
  isExpiredQuestionError,
  pendingQuestion,
  QUESTION_EXPIRED_MESSAGE,
} from "@/lib/runtime/pending-question";

function message(role: "user" | "assistant", uuid: string, content: ContentBlock[]): AgentEvent {
  return { t: "message", uuid, parentUuid: null, role, timestamp: "2026-10-22T10:00:00Z", content };
}

const questions = [
  { header: "Storage", question: "Where?", options: [{ label: "DB", description: "Columns" }, "Facts"] },
  { question: "Which platforms?", options: [{ label: "Mac" }, { label: "Cloud" }], multiSelect: true },
];
const ask = message("assistant", "a1", [
  { type: "text", text: "One decision first." },
  { type: "tool_use", id: "t1", name: ASK_TOOL, input: { questions } },
]);
const prompt = message("user", "u0", [{ type: "text", text: "plan it" }]);

test("the newest ask_user call without a result is pending", () => {
  const pending = pendingQuestion([prompt, ask]);
  assert.equal(pending?.toolUseId, "t1");
  // A bare-string option reads as its label, as the agent reads it.
  assert.deepEqual(pending?.questions[0].options[1], { label: "Facts", description: undefined });
  // The answer carries the questions exactly as asked: the agent matches them.
  assert.equal(pending?.raw, questions);
});

test("a question is over once answered, or once anything but a tool result follows it", () => {
  const result = message("user", "r1", [{ type: "tool_result", toolUseId: "t1", content: "The user answered" }]);
  assert.equal(pendingQuestion([prompt, ask, result]), null);

  // Another tool's result doesn't answer it.
  const other = message("user", "r2", [{ type: "tool_result", toolUseId: "t0", content: "ok" }]);
  assert.equal(pendingQuestion([prompt, ask, other])?.toolUseId, "t1");

  // A prompt after it, or a stopped turn, leaves no call waiting (a session
  // killed mid-question records no result).
  assert.equal(pendingQuestion([prompt, ask, message("user", "u1", [{ type: "text", text: "never mind" }])]), null);
  assert.equal(
    pendingQuestion([prompt, ask, message("user", "u2", [{ type: "text", text: "[Request interrupted by user for tool use]" }])]),
    null,
  );
  assert.equal(pendingQuestion([prompt, ask, { t: "state", workspaceId: "w", state: "exited" }]), null);
  assert.equal(pendingQuestion([prompt, ask, { t: "state", workspaceId: "w", state: "running" }])?.toolUseId, "t1");
});

test("an ask_user call the card can't show is no question", () => {
  const malformed = message("assistant", "a2", [{ type: "tool_use", id: "t2", name: ASK_TOOL, input: { questions: [] } }]);
  assert.equal(pendingQuestion([prompt, malformed]), null);
  const otherTool = message("assistant", "a3", [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { questions } }]);
  assert.equal(pendingQuestion([prompt, otherTool]), null);
});

test("an answer is complete with one choice, or several where the question takes them", () => {
  const [single, multi] = pendingQuestion([ask])!.questions;
  assert.equal(isAnswered(single, { selected: [], other: "  " }), false);
  assert.equal(isAnswered(single, { selected: ["DB"], other: "" }), true);
  assert.equal(isAnswered(single, { selected: [], other: "Redis" }), true);
  assert.equal(isAnswered(single, { selected: ["DB"], other: "Redis" }), false);
  assert.equal(isAnswered(multi, { selected: ["Mac", "Cloud"], other: "Linux" }), true);
  assert.equal(isAnswered(multi, undefined), false);
});

test("an expired question is recognised from the agent's own words, either way they arrive", () => {
  // Pinned to the agent's ask.ErrNotWaiting, which the desktop app passes through.
  const goSource = readFileSync(
    fileURLToPath(new URL("../runtime-agent/internal/ask/ask.go", import.meta.url)),
    "utf8",
  );
  assert.ok(goSource.includes(`errors.New("${QUESTION_EXPIRED_MESSAGE}")`));
  assert.equal(isExpiredQuestionError(`agent: ${QUESTION_EXPIRED_MESSAGE}`), true); // local
  assert.equal(isExpiredQuestionError("This question is no longer waiting for an answer"), true); // cloud
  assert.equal(isExpiredQuestionError("agent-unreachable: connection refused"), false);
});

test("an ask_user call's row says what it asked", () => {
  assert.deepEqual(toolRow(ASK_TOOL, { questions: [questions[0]] }), {
    kind: "question",
    label: "Where?",
    mono: false,
    title: null,
    stats: null,
  });
  assert.equal(toolRow(ASK_TOOL, { questions }).label, "Asked you 2 questions");
  assert.equal(toolRow(ASK_TOOL, null).label, "Asked you");
});
