import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { compactTokens, contextUsage, contextWindowFor } from "@/lib/runtime/context-usage";

const usage = { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 500, cache_read_input_tokens: 18000 };
const reply = (extra: Partial<Extract<AgentEvent, { t: "message" }>> = {}): AgentEvent => ({
  t: "message",
  uuid: crypto.randomUUID(),
  parentUuid: null,
  role: "assistant",
  timestamp: "t",
  content: [{ type: "text", text: "ok" }],
  ...extra,
});

test("the context is what the newest reply read and wrote, out of the model's window", () => {
  assert.equal(contextUsage([]), null);
  assert.equal(contextUsage([reply()]), null, "an agent from before usage says nothing");
  assert.deepEqual(contextUsage([reply({ usage: { ...usage, input_tokens: 99 } }), reply({ usage, model: "claude-opus-5-5" })]), {
    used: 18543,
    window: 200_000,
  });
  // Codex's log says its window.
  assert.deepEqual(contextUsage([reply({ usage, contextWindow: 258400 })]), { used: 18543, window: 258400 });
  // A model with a million tokens of context.
  assert.equal(contextUsage([reply({ usage, model: "claude-opus-4-6[1m]" })])?.window, 1_000_000);
  // A reply without usage after one with it: the one that said.
  assert.equal(contextUsage([reply({ usage }), reply()])?.used, 18543);
});

test("after a compaction the ring waits for the next reply to say", () => {
  const compacted: AgentEvent = { ...reply(), content: [], compact: { trigger: "manual" } } as AgentEvent;
  assert.equal(contextUsage([reply({ usage }), compacted]), null);
  assert.equal(contextUsage([reply({ usage }), compacted, reply({ usage: { ...usage, cache_read_input_tokens: 0 } })])?.used, 543);
});

test("token counts read short", () => {
  assert.equal(compactTokens(812), "812");
  assert.equal(compactTokens(1500), "1.5k");
  assert.equal(compactTokens(45231), "45k");
  assert.equal(compactTokens(200_000), "200k");
  assert.equal(compactTokens(1_000_000), "1M");
  assert.equal(contextWindowFor(undefined), 200_000);
});

test("a call's own context wins over usage that sums two calls (a Codex translation)", () => {
  // Usage carries a late call's tokens for the session's totals; the context
  // is the record's own call's.
  const summed = { input_tokens: 20, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_990 };
  assert.deepEqual(contextUsage([reply({ usage: summed, contextTokens: 51_020, contextWindow: 258400 })]), {
    used: 51_020,
    window: 258400,
  });
});

test("after a compaction that says what it left, the ring shows that, out of the window before it", () => {
  const compacted = { ...reply(), content: [], compact: { trigger: "manual", preTokens: 152_318, postTokens: 9876 } } as AgentEvent;
  assert.deepEqual(contextUsage([reply({ usage, contextWindow: 258400 }), compacted]), { used: 9876, window: 258400 });
  assert.deepEqual(contextUsage([compacted], "claude-opus-4-6[1m]"), { used: 9876, window: 1_000_000 });
});
