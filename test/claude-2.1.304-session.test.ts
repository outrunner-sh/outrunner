import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { claudeIsWorking } from "@/lib/runtime/conversation-events";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";
import { contextUsage } from "@/lib/runtime/context-usage";
import { pendingPlan } from "@/lib/runtime/pending-plan";
import { parseConversation } from "@/lib/runtime/replay/conversation";

// A whole session of a real Claude Code 2.1.304, the version a box runs
// (runtime-agent/internal/conversation/testdata, shared with the Go decoder):
// a plan in plan mode, declined with Escape, revised, approved in Claude's own
// menu and built; a turn stopped with Escape; then /compact with instructions.
const events = parseConversation(
  readFileSync(
    fileURLToPath(new URL("../runtime-agent/internal/conversation/testdata/claude-2.1.304.jsonl", import.meta.url)),
    "utf8",
  ),
);

test("a real session's plans, stops and compaction show as the timeline means them", () => {
  const nodes = conversationNodes(events);
  const kinds = nodes.map((n) => n.kind);
  assert.equal(kinds.filter((k) => k === "plan").length, 2, "both plans are cards");
  assert.equal(kinds.filter((k) => k === "compact").length, 1);
  assert.ok(kinds.filter((k) => k === "interrupted").length >= 2, "the declined plan and the stopped turn");
  const prompts = nodes.filter((n) => n.kind === "prompt");
  assert.ok(prompts.some((p) => p.kind === "prompt" && p.mode === "plan"), "a prompt sent in plan mode says so");
  assert.ok(
    prompts.every((p) => p.kind === "prompt" && !p.text.startsWith("/compact") && !p.text.startsWith("<")),
    "neither the typed /compact nor Claude's records of it read as prompts",
  );
  assert.ok(!prompts.some((p) => p.kind === "prompt" && p.text.startsWith("This session is being continued")), "no summary");
  const compact = nodes.find((n) => n.kind === "compact");
  assert.deepEqual(compact && { trigger: compact.trigger, pre: compact.preTokens, post: compact.postTokens }, {
    trigger: "manual",
    pre: 22269,
    post: 3956,
  });
});

test("after it, nothing waits: no plan, no turn, and the ring says what the summary left", () => {
  assert.equal(pendingPlan(events), null);
  assert.equal(claudeIsWorking(events), false);
  assert.deepEqual(contextUsage(events, "claude-opus-4-7"), { used: 3956, window: 200_000 });
});

test("cut at the first plan, it waits on the user, and the turn isn't read as at work", () => {
  const at = events.findIndex((e) => e.t === "message" && e.content.some((b) => b.type === "tool_use" && b.name === "ExitPlanMode"));
  const plan = pendingPlan(events.slice(0, at + 1));
  assert.ok(plan && plan.dismiss && plan.plan.startsWith("# Plan: add `double`"));
});
