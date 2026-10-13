import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_DEFAULTS, parseSessionDefaults } from "@/lib/runtime/session-defaults";

test("nothing stored, or junk, is no defaults", () => {
  for (const raw of [undefined, null, "x", 3, {}, { local: "codex" }, { cloud: [] }]) {
    assert.deepEqual(parseSessionDefaults(raw), NO_DEFAULTS, JSON.stringify(raw));
  }
});

test("each place keeps only a model its agent can run", () => {
  assert.deepEqual(
    parseSessionDefaults({ local: { agent: "codex", model: "gpt-6-luna" }, cloud: { model: "sonnet" } }),
    { local: { agent: "codex", model: "gpt-6-luna" }, cloud: { model: "sonnet" } },
  );
  // Claude Code on this Mac: one of its own models only.
  assert.equal(parseSessionDefaults({ local: { agent: "claude", model: "opus" } }).local.model, "opus");
  assert.equal(parseSessionDefaults({ local: { agent: "claude", model: "gpt-6-luna" } }).local.model, null);
  // Codex: whatever Codex lists, but never something shaped like an option.
  assert.equal(parseSessionDefaults({ local: { agent: "codex", model: "--yolo" } }).local.model, null);
  // The cloud: its menu's models (Outrunner's, the Claude account's).
  assert.equal(parseSessionDefaults({ cloud: { model: "z-ai/glm-5.3" } }).cloud.model, "z-ai/glm-5.3");
  assert.equal(parseSessionDefaults({ cloud: { model: "gpt-6-luna" } }).cloud.model, null);
  // An unknown agent is Claude Code.
  assert.equal(parseSessionDefaults({ local: { agent: "gemini" } }).local.agent, "claude");
});
