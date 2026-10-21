import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { promptWithAttachments } from "@/lib/runtime/attachments";
import { firstUserPrompt, isInterruption, messageText, userPromptCount, userPrompts } from "@/lib/runtime/conversation-events";

let n = 0;
const message = (role: "user" | "assistant", content: unknown[]): AgentEvent => ({
  t: "message",
  uuid: `m${++n}`,
  parentUuid: null,
  role,
  timestamp: "2026-10-09T00:00:00Z",
  content: content as Extract<AgentEvent, { t: "message" }>["content"],
});
const text = (value: string) => ({ type: "text", text: value });
const toolResult = { type: "tool_result", toolUseId: "t1", content: "ok" };

test("messageText joins a message's text blocks and trims them", () => {
  assert.equal(messageText(message("user", [text("  fix "), { type: "thinking" }, text("the bug  ")])), "fix the bug");
  assert.equal(messageText({ t: "state", workspaceId: "w", state: "running" }), "");
});

test("the first prompt is the first user message with text", () => {
  const events = [
    { t: "state", workspaceId: "w", state: "running" } as AgentEvent,
    message("user", [text("Pull latest code from main")]),
    message("assistant", [text("Pulling…")]),
    message("user", [text("now run the tests")]),
  ];
  assert.equal(firstUserPrompt(events), "Pull latest code from main");
});

test("Claude's tool-result turns are not prompts", () => {
  const events = [message("user", [toolResult]), message("user", [text("the real ask")])];
  assert.equal(firstUserPrompt(events), "the real ask");
  assert.equal(userPromptCount(events), 1);
});

test("the attachment header Runtime adds is not part of the prompt", () => {
  const events = [message("user", [text(promptWithAttachments("what is wrong here?", ["shot.png"]))])];
  assert.equal(firstUserPrompt(events), "what is wrong here?");
});

test("a prompt of only files gives way to the next prompt with words", () => {
  const events = [
    message("user", [text(promptWithAttachments("", ["shot.png"]))]),
    message("user", [text("explain the screenshot")]),
  ];
  assert.equal(firstUserPrompt(events), "explain the screenshot");
});

test("no prompt yet is null", () => {
  assert.equal(firstUserPrompt([]), null);
  assert.equal(firstUserPrompt([message("assistant", [text("hello")])]), null);
});

test("Claude's record of a stopped turn is not a prompt", () => {
  const stopped = message("user", [text("[Request interrupted by user]")]);
  const stoppedTool = message("user", [text("[Request interrupted by user for tool use]")]);
  assert.ok(isInterruption(stopped) && isInterruption(stoppedTool));
  assert.equal(isInterruption(message("user", [text("why was the [Request interrupted by user] shown?")])), false);
  const events = [stopped, message("user", [text("try again")]), stoppedTool];
  assert.deepEqual(userPrompts(events), ["try again"]);
  assert.equal(firstUserPrompt(events), "try again");
});
