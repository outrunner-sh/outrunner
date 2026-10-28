import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { claudeIsWorking } from "@/lib/runtime/conversation-events";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";
import { pendingPlan, planFileName, planOf } from "@/lib/runtime/pending-plan";
import { readQueue } from "@/lib/session/prompt-queue";
import { composerCommand, otherMode } from "@/lib/session/session-mode";

let n = 0;
function message(role: "user" | "assistant", content: ContentBlock[], extra: Partial<AgentEvent> = {}): AgentEvent {
  n += 1;
  return { t: "message", uuid: `${role}-${n}`, parentUuid: null, role, timestamp: "2026-10-28T10:00:00Z", content, ...extra } as AgentEvent;
}
const prompt = (text: string, mode?: "plan") => message("user", [{ type: "text", text }], mode ? { mode } : {});
const exitPlan = (id: string, plan: string) => message("assistant", [{ type: "tool_use", id, name: "ExitPlanMode", input: { plan } }]);
const said = (text: string) => message("assistant", [{ type: "text", text }]);

test("/plan and /compact are the composer's own; any other slash command goes to the agent", () => {
  assert.deepEqual(composerCommand("/plan add dark mode"), { kind: "plan", prompt: "add dark mode" });
  assert.deepEqual(composerCommand("  /plan\nfirst line\nsecond  "), { kind: "plan", prompt: "first line\nsecond" });
  assert.deepEqual(composerCommand("/plan"), { kind: "plan", prompt: "" });
  assert.deepEqual(composerCommand("/compact"), { kind: "compact", instructions: "" });
  assert.deepEqual(composerCommand("/compact keep the test names"), { kind: "compact", instructions: "keep the test names" });
  assert.equal(composerCommand("/planet"), null);
  assert.equal(composerCommand("/model opus"), null);
  assert.equal(composerCommand("please /plan this"), null);
  assert.equal(otherMode("plan"), "build");
  assert.equal(otherMode("build"), "plan");
});

test("Claude's plan waits on the user until it is answered", () => {
  const events = [prompt("Plan dark mode", "plan"), said("Let me look around."), exitPlan("t1", "# Dark mode\n\n1. Add a toggle")];
  assert.deepEqual(pendingPlan(events), { id: "t1", plan: "# Dark mode\n\n1. Add a toggle", dismiss: true });
  // Escape declined it (Approve and Revise both do): a result, so it's over.
  const answered = [...events, message("user", [{ type: "tool_result", toolUseId: "t1", content: "The user doesn't want to proceed" }])];
  assert.equal(pendingPlan(answered), null);
  // A prompt since (typed in the terminal) is an answer too.
  assert.equal(pendingPlan([...events, prompt("no, smaller")]), null);
  // A call with no plan in it is no card.
  assert.equal(pendingPlan([prompt("x"), exitPlan("t2", "  ")]), null);
  assert.equal(planOf({ plan: 3 }), null);
});

test("Claude's plan doesn't read as a turn at work: it waits on the user", () => {
  // claudeIsWorking alone would say working (its last step is a tool call);
  // the session asks pendingPlan first.
  const events = [prompt("Plan it", "plan"), exitPlan("t1", "1. Do it")];
  assert.equal(claudeIsWorking(events), true);
  assert.ok(pendingPlan(events));
});

test("Codex's plan is the last words of a turn sent in plan mode, once it is over", () => {
  const events = [prompt("Plan dark mode", "plan"), said("Looking at the settings page."), said("## Plan\n1. Toggle")];
  const reply = events[2] as Extract<AgentEvent, { t: "message" }>;
  assert.deepEqual(pendingPlan(events, { plansInProse: true }), { id: reply.uuid, plan: "## Plan\n1. Toggle", dismiss: false });
  assert.equal(pendingPlan(events, { plansInProse: true, working: true }), null, "not while the turn goes on");
  assert.equal(pendingPlan([prompt("Build it"), said("Done.")], { plansInProse: true }), null, "a build turn's words are words");
  assert.equal(pendingPlan(events), null, "Claude's words are never a plan: it has ExitPlanMode");

  const nodes = conversationNodes(events, { plansInProse: true });
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ["prompt", "prose", "plan"],
  );
  assert.equal(nodes[0].kind === "prompt" && nodes[0].mode, "plan");
  assert.equal(nodes[2].kind === "plan" && nodes[2].id, reply.uuid);
  // Under way: still words.
  assert.deepEqual(
    conversationNodes(events, { plansInProse: true, working: true }).map((node) => node.kind),
    ["prompt", "prose", "prose"],
  );
});

test("an ExitPlanMode call is a plan card in the conversation, not a tool row", () => {
  const nodes = conversationNodes([prompt("Plan it", "plan"), exitPlan("t1", "1. Do it")]);
  assert.deepEqual(nodes.map((node) => node.kind), ["prompt", "plan"]);
  assert.deepEqual(nodes[1].kind === "plan" && { id: nodes[1].id, text: nodes[1].text }, { id: "t1", text: "1. Do it" });
});

test("a compaction is a row, and /compact's own records are not prompts", () => {
  const compacted = message("assistant", [], { compact: { trigger: "manual", preTokens: 45231 } });
  const command = message("user", [{ type: "text", text: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" }]);
  const printed = message("user", [{ type: "text", text: "<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>" }]);
  const model = message("user", [{ type: "text", text: "<command-name>/model</command-name>\n<command-args>opus</command-args>" }]);
  const nodes = conversationNodes([prompt("fix it"), said("done"), compacted, command, printed, model]);
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ["prompt", "prose", "compact", "command"],
  );
  assert.deepEqual(nodes[2], { kind: "compact", key: nodes[2].key, trigger: "manual", preTokens: 45231 });
  assert.equal(nodes[3].kind === "command" && nodes[3].text, "/model opus");
  // Neither a compaction nor a command Claude ran itself is a turn at work.
  assert.equal(claudeIsWorking([prompt("fix it"), said("done"), compacted]), false);
  assert.equal(claudeIsWorking([prompt("fix it"), said("done"), compacted, command, printed]), false);
});

test("a compaction ends any plan waiting", () => {
  const compacted = message("assistant", [], { compact: {} });
  assert.equal(pendingPlan([prompt("Plan", "plan"), exitPlan("t1", "1. x"), compacted]), null);
});

test("a queued prompt keeps its mode, and a queue from before modes still reads", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  };
  stored.set(
    "outrunner:queue:ws",
    JSON.stringify([
      { id: "a", text: "plan it", attachmentIds: [], mode: "plan" },
      { id: "b", text: "old", attachmentIds: [] },
      { id: "c", text: "bad", attachmentIds: [], mode: "yolo" },
    ]),
  );
  assert.deepEqual(
    readQueue(storage, "ws").map((p) => [p.id, p.mode]),
    [
      ["a", "plan"],
      ["b", undefined],
    ],
  );
});

test("a plan downloads under its first heading", () => {
  assert.equal(planFileName("# Plan: Add dark mode\n\n1. x"), "plan-add-dark-mode.md");
  assert.equal(planFileName("## Fix the flaky test in CI\n"), "plan-fix-the-flaky-test-in-ci.md");
  assert.equal(planFileName("1. just steps"), "plan.md");
});

test("a plan kept in a file is still a card, saying where the file is", () => {
  // Claude Code 2.1.304 puts the file's text in the call (`plan`) beside its path.
  assert.equal(planOf({ plan: "1. x", planFilePath: "/home/runtime/.claude/plans/p.md" }), "1. x");
  assert.equal(planOf({ planFilePath: "/home/runtime/.claude/plans/p.md" }), "The plan is in `/home/runtime/.claude/plans/p.md`.");
  assert.ok(pendingPlan([prompt("Plan it", "plan"), message("assistant", [{ type: "tool_use", id: "t9", name: "ExitPlanMode", input: { planFilePath: "/p.md" } }])]));
});

test("the page reads a custom command as answered, and a local command's output as the turn over", () => {
  const review = message("user", [{ type: "text", text: "<command-message>review is running…</command-message>\n<command-name>/review</command-name>" }]);
  assert.equal(claudeIsWorking([prompt("x"), said("done"), review]), true);
  const printed = message("user", [{ type: "text", text: "<local-command-stdout>Set model to opus</local-command-stdout>" }]);
  assert.equal(claudeIsWorking([prompt("x"), said("done"), printed]), false);
});
