import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_MODELS, matchModel, modelLabel } from "@/lib/runtime/session-models";

test("a reported model id matches its family's alias", () => {
  assert.equal(matchModel(CLAUDE_MODELS, "claude-opus-5")?.id, "opus");
  assert.equal(matchModel(CLAUDE_MODELS, "claude-sonnet-5")?.id, "sonnet");
  assert.equal(matchModel(CLAUDE_MODELS, "claude-haiku-4-5-20251001")?.id, "haiku");
  assert.equal(matchModel(CLAUDE_MODELS, "sonnet")?.id, "sonnet");
});

test("a model outside the offered ones matches none", () => {
  assert.equal(matchModel(CLAUDE_MODELS, "z-ai/glm-5.3"), undefined);
  assert.equal(matchModel(CLAUDE_MODELS, "claude-opusx"), undefined);
  assert.equal(matchModel(CLAUDE_MODELS, undefined), undefined);
  assert.equal(matchModel(CLAUDE_MODELS, ""), undefined);
});

test("the label drops Claude's release date only", () => {
  assert.equal(modelLabel("claude-opus-4-5-20250115"), "claude-opus-4-5");
  assert.equal(modelLabel("claude-opus-5"), "claude-opus-5");
  assert.equal(modelLabel("z-ai/glm-5.3"), "z-ai/glm-5.3");
});
