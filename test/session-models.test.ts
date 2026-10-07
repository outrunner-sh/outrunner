import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_GROUPS, matchModel, modelLabel } from "@/lib/runtime/session-models";

test("a Claude account reply matches its family's alias", () => {
  assert.equal(matchModel(MODEL_GROUPS, "claude-opus-5")?.id, "opus");
  assert.equal(matchModel(MODEL_GROUPS, "claude-sonnet-5")?.id, "sonnet");
  assert.equal(matchModel(MODEL_GROUPS, "claude-haiku-4-5-20251001")?.id, "haiku");
  assert.equal(matchModel(MODEL_GROUPS, "sonnet")?.source, "claude");
});

test("a Neev AI reply matches its OpenRouter slug, not a Claude alias", () => {
  assert.deepEqual(matchModel(MODEL_GROUPS, "z-ai/glm-5.3"), { id: "z-ai/glm-5.3", label: "GLM 5.3", source: "neev" });
  // OpenRouter's Sonnet is Neev AI's, though the name says Sonnet.
  assert.equal(matchModel(MODEL_GROUPS, "anthropic/claude-sonnet-5")?.source, "neev");
});

test("a model outside the menu matches none", () => {
  assert.equal(matchModel(MODEL_GROUPS, "z-ai/glm-4.6"), undefined);
  assert.equal(matchModel(MODEL_GROUPS, "claude-opusx"), undefined);
  assert.equal(matchModel(MODEL_GROUPS, undefined), undefined);
});

test("Neev AI comes first in the menu", () => {
  assert.deepEqual(MODEL_GROUPS.map((g) => g.label), ["Neev AI", "Claude account"]);
});

test("the label drops Claude's release date only", () => {
  assert.equal(modelLabel("claude-opus-4-5-20250115"), "claude-opus-4-5");
  assert.equal(modelLabel("z-ai/glm-5.3"), "z-ai/glm-5.3");
});
