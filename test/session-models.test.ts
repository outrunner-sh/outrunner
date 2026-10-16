import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CLOUD_MODEL,
  MODEL_GROUPS,
  matchModel,
  modelGroups,
  modelLabel,
  offeredModel,
  setModelRequest,
} from "@/lib/runtime/session-models";

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

test("Outrunner's models come first in the menu", () => {
  assert.deepEqual(MODEL_GROUPS.map((g) => g.label), ["Outrunner", "Claude account"]);
});

test("the label drops Claude's release date only", () => {
  assert.equal(modelLabel("claude-opus-4-5-20250115"), "claude-opus-4-5");
  assert.equal(modelLabel("z-ai/glm-5.3"), "z-ai/glm-5.3");
});

test("an Outrunner model switches through OpenRouter on the key it is handed", async () => {
  const req = await setModelRequest("z-ai/glm-5.3", async () => "sk-or-v1-test-key-0123456789");
  assert.deepEqual(req, { model: "z-ai/glm-5.3", gateway: "openrouter", token: "sk-or-v1-test-key-0123456789" });
});

test("a Claude account model switches on the session's own login, without asking for a key", async () => {
  let asked = false;
  const req = await setModelRequest("opus", async () => {
    asked = true;
    return "unused";
  });
  assert.deepEqual(req, { model: "opus" });
  assert.equal(asked, false);
});

test("anything off the menu is refused before a key is fetched", async () => {
  for (const id of ["claude-opus-5", "openai/gpt-5", "", undefined, 42, { id: "opus" }]) {
    const req = await setModelRequest(id, async () => assert.fail(`fetched a key for ${String(id)}`));
    assert.equal(req, null, `accepted ${JSON.stringify(id)}`);
  }
});

test("a key that can't be had fails the switch", async () => {
  await assert.rejects(
    setModelRequest("z-ai/glm-5.3", async () => {
      throw new Error("Outrunner's models aren't set up");
    }),
    /aren't set up/,
  );
});

test("cloud sessions default to an Outrunner model on the menu", () => {
  assert.equal(DEFAULT_CLOUD_MODEL.source, "neev");
  assert.equal(offeredModel(DEFAULT_CLOUD_MODEL.id), DEFAULT_CLOUD_MODEL);
});

test("Outrunner's models are named after the key they run on: the user's own, or Outrunner's", () => {
  assert.deepEqual(modelGroups(false).map((g) => g.label), ["Outrunner", "Claude account"]);
  const own = modelGroups(true);
  assert.deepEqual(own.map((g) => g.label), ["OpenRouter · your key", "Claude account"]);
  // The same models either way: only whose key pays for them differs.
  assert.deepEqual(own[0].models, MODEL_GROUPS[0].models);
});
