import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { compactTokens, contextLevel, contextUsage, contextWindowFor } from "@/lib/runtime/context-usage";
import { parseConversation } from "@/lib/runtime/replay/conversation";

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

test("the context is what the newest reply read, out of the model's window", () => {
  assert.equal(contextUsage([]), null);
  assert.equal(contextUsage([reply()]), null, "an agent from before usage says nothing");
  // What it wrote isn't counted: it's in the next call's input (Claude Code's
  // own count, and its status line's).
  assert.deepEqual(contextUsage([reply({ usage: { ...usage, input_tokens: 99 } }), reply({ usage, model: "claude-opus-5-5" })]), {
    used: 18503,
    window: 1_000_000,
    compactAt: 967_000,
  });
  // Codex's log says its window; it says nothing of compacting.
  assert.deepEqual(contextUsage([reply({ usage, contextWindow: 258400 })]), { used: 18503, window: 258400, compactAt: null });
  // A reply without usage after one with it: the one that said.
  assert.equal(contextUsage([reply({ usage }), reply()])?.used, 18503);
});

test("the window is Claude Code's, for every form a model's ID takes", () => {
  // As Claude Code 2.1.304's /context reported each (Nov 12).
  const windows: Record<string, number> = {
    // Its aliases, run by Claude Code itself.
    opus: 1_000_000,
    sonnet: 1_000_000,
    haiku: 1_000_000,
    // Bare, dated, and the [1m] suffix.
    "claude-opus-5-5": 1_000_000,
    "claude-sonnet-5-5": 1_000_000,
    "claude-haiku-5-5": 1_000_000,
    "claude-fable-5-1": 1_000_000,
    "claude-sonnet-5-5-20261001": 1_000_000,
    "claude-sonnet-5-20261001": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 200_000,
    "claude-opus-4-6[1m]": 1_000_000,
    "claude-sonnet-4-6": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
    "claude-haiku-5": 200_000,
    "claude-opus-47": 200_000,
    // Bedrock's and Vertex's.
    "us.anthropic.claude-opus-4-7-v1:0": 1_000_000,
    "claude-opus-4-7@20260101": 1_000_000,
    // OpenRouter's: a dotted minor isn't one to Claude Code.
    "anthropic/claude-opus-5.5": 1_000_000,
    "anthropic/claude-sonnet-5.5": 1_000_000,
    "anthropic/claude-sonnet-5": 1_000_000,
    "anthropic/claude-opus-4-7": 1_000_000,
    "anthropic/claude-opus-4.7": 200_000,
    "anthropic/claude-haiku-5.5": 200_000,
    // A gateway's: an ID Claude Code doesn't know.
    "z-ai/glm-5.3": 200_000,
    "moonshotai/kimi-k3": 200_000,
    "deepseek/deepseek-v4.1-flash": 200_000,
    "glm-5.3": 200_000,
  };
  for (const [model, window] of Object.entries(windows)) assert.equal(contextWindowFor(model), window, model);
  assert.equal(contextWindowFor(undefined), 200_000);
});

test("before any reply, the composer's model names the window", () => {
  const compacted = { ...reply(), content: [], compact: { trigger: "manual", preTokens: 152_318, postTokens: 9876 } } as AgentEvent;
  // Claude's own launch: the alias.
  assert.deepEqual(contextUsage([compacted], "opus"), { used: 9876, window: 1_000_000, compactAt: 967_000 });
  // A gateway's: its own model, as the composer and the log name it.
  assert.deepEqual(contextUsage([compacted], "z-ai/glm-5.3"), { used: 9876, window: 200_000, compactAt: 167_000 });
});

test("after a compaction the ring waits for the next reply to say", () => {
  const compacted: AgentEvent = { ...reply(), content: [], compact: { trigger: "manual" } } as AgentEvent;
  assert.equal(contextUsage([reply({ usage }), compacted]), null);
  assert.equal(contextUsage([reply({ usage }), compacted, reply({ usage: { ...usage, cache_read_input_tokens: 0 } })])?.used, 503);
});

test("token counts read short", () => {
  assert.equal(compactTokens(812), "812");
  assert.equal(compactTokens(1500), "1.5k");
  assert.equal(compactTokens(45231), "45k");
  assert.equal(compactTokens(200_000), "200k");
  assert.equal(compactTokens(967_000), "967k");
  assert.equal(compactTokens(1_000_000), "1M");
});

test("a call's own context wins over usage that sums two calls (a Codex translation)", () => {
  // Usage carries a late call's tokens for the session's totals; the context
  // is the record's own call's.
  const summed = { input_tokens: 20, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_990 };
  assert.deepEqual(contextUsage([reply({ usage: summed, contextTokens: 51_020, contextWindow: 258400 })]), {
    used: 51_020,
    window: 258400,
    compactAt: null,
  });
});

test("after a compaction that says what it left, the ring shows that, out of the window before it", () => {
  const compacted = { ...reply(), content: [], compact: { trigger: "manual", preTokens: 152_318, postTokens: 9876 } } as AgentEvent;
  assert.deepEqual(contextUsage([reply({ usage, contextWindow: 258400 }), compacted]), { used: 9876, window: 258400, compactAt: null });
  assert.deepEqual(contextUsage([compacted], "claude-opus-4-6[1m]"), { used: 9876, window: 1_000_000, compactAt: 967_000 });
});

test("where Claude compacted on its own is where it compacts: a /compact's says nothing", () => {
  const auto = { ...reply(), content: [], compact: { trigger: "auto", preTokens: 801_234, postTokens: 30_000 } } as AgentEvent;
  const manual = { ...reply(), content: [], compact: { trigger: "manual", preTokens: 400_000, postTokens: 20_000 } } as AgentEvent;
  const opus = reply({ usage, model: "claude-opus-5-5" });
  assert.equal(contextUsage([opus, auto])?.compactAt, 801_234);
  assert.equal(contextUsage([opus, auto, reply({ usage, model: "claude-opus-5-5" })])?.compactAt, 801_234);
  assert.equal(contextUsage([opus, manual, reply({ usage, model: "claude-opus-5-5" })])?.compactAt, 967_000);
  assert.equal(contextUsage([opus, auto, manual])?.compactAt, 801_234);
});

test("a session's log with a compaction replays to the ring", () => {
  // Shaped as Claude Code 2.1.304 writes them (runtime-agent/internal/conversation/testdata).
  const line = (rec: object) => JSON.stringify(rec);
  const jsonl = [
    line({ type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "go" } }),
    line({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "t2",
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 2, output_tokens: 900, cache_creation_input_tokens: 4000, cache_read_input_tokens: 239_000 },
      },
    }),
  ];
  // 243k read: out of a million, not over 200k.
  assert.deepEqual(contextUsage(parseConversation(jsonl.join("\n"))), { used: 243_002, window: 1_000_000, compactAt: 967_000 });
  jsonl.push(
    line({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      uuid: "c1",
      parentUuid: null,
      logicalParentUuid: "a1",
      timestamp: "t3",
      compactMetadata: { trigger: "auto", preTokens: 967_420, postTokens: 31_500 },
    }),
  );
  assert.deepEqual(contextUsage(parseConversation(jsonl.join("\n"))), { used: 31_500, window: 1_000_000, compactAt: 967_420 });
});

test("the ring warns as compaction nears, and says when it's over", () => {
  const at = (used: number, window = 1_000_000, compactAt: number | null = 967_000) => contextLevel({ used, window, compactAt });
  assert.equal(at(243_000), "ok");
  assert.equal(at(780_000), "near");
  assert.equal(at(920_000), "now");
  assert.equal(at(1_000_001), "over");
  assert.equal(at(150_000, 200_000, 167_000), "near");
  assert.equal(at(243_000, 200_000, 167_000), "over");
  // Codex's: toward its window.
  assert.equal(at(210_000, 258_400, null), "near");
  assert.equal(at(250_000, 258_400, null), "now");
});

test("an API error's stand-in reply counts no tokens: the reply before it says", () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const failed = reply({ model: "<synthetic>", usage: zero, content: [{ type: "text", text: "API Error: 400 bad request" }] });
  assert.deepEqual(contextUsage([reply({ usage, model: "claude-opus-5-5" }), failed]), {
    used: 18503,
    window: 1_000_000,
    compactAt: 967_000,
  });
});
