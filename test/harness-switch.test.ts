import assert from "node:assert/strict";
import test from "node:test";
import { exhaustion, hasUnfinishedRequest } from "@/lib/session/harness-switch";
import { parseConversation } from "@/lib/runtime/replay/conversation";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";

const request = { type: "user", uuid: "u", message: { role: "user", content: "Finish the change" } };
const reply = (text: string, model = "sonnet", stop_reason = "end_turn") => ({ type: "assistant", uuid: "a", message: { role: "assistant", model, stop_reason, content: [{ type: "text", text }] } });
const events = (...records: unknown[]) => parseConversation(records.map((r) => JSON.stringify(r)).join("\n"));

test("quota recovery distinguishes a runtime failure from ordinary prose and transient errors", () => {
  assert.equal(exhaustion(events(request, reply("You've hit your limit · resets tomorrow", "<synthetic>"))), "quota");
  assert.equal(exhaustion(events(request, reply("Your credit balance is too low", "<synthetic>"))), "credits");
  for (const text of ["API Error: 429 rate limited", "API Error: 401 unauthorized", "network unavailable", "context window exceeded"]) {
    assert.equal(exhaustion(events(request, reply(text, "<synthetic>"))), null);
  }
  assert.equal(exhaustion(events(request, reply("You've hit your limit"))), null);
});

test("only unfinished requests can be resumed", () => {
  assert.equal(hasUnfinishedRequest(events(request)), true);
  assert.equal(hasUnfinishedRequest(events(request, reply("Done"))), false);
  assert.equal(hasUnfinishedRequest(events(request, reply("Looking at files", "sonnet", "tool_use"))), true);
  assert.equal(hasUnfinishedRequest(events(request, reply("Usage limit reached", "<synthetic>"))), true);
});

test("replay preserves harness boundaries without counting them as prompts or replies", () => {
  const history = events(request, reply("Done"), { type: "outrunner_harness_switch", uuid: "handoff", outrunnerHarness: { from: "claude", agent: "codex" } });
  const boundary = history.at(-1);
  assert.deepEqual(boundary?.t === "message" ? boundary.harness : null, { from: "claude", to: "codex" });
  assert.equal(hasUnfinishedRequest(history), false);
  assert.equal(exhaustion(events(request, reply("You've hit your limit", "<synthetic>"), { type: "outrunner_harness_switch", uuid: "switched", outrunnerHarness: { from: "claude", agent: "codex" } })), null);
  assert.ok(conversationNodes(history).some((n) => n.kind === "harness"));
});
