import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { rememberCustomModel, rememberedCustomModels, takesTypedModels } from "@/lib/runtime/custom-models";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

test("ids typed in are remembered per provider, newest first, valid only, five at most", () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  };
  for (const id of ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-2"]) rememberCustomModel("zai", id);
  assert.deepEqual(rememberedCustomModels("zai").map((m) => m.id), ["a-2", "a-6", "a-5", "a-4", "a-3"]);
  assert.deepEqual(rememberedCustomModels("moonshot"), [], "each provider its own");

  // Listed already, or not an id the agent takes: not remembered.
  rememberCustomModel("zai", "glm-5.3");
  rememberCustomModel("zai", "-rf");
  assert.equal(rememberedCustomModels("zai")[0].id, "a-2");
  // Whatever else is in storage is dropped, not offered.
  store.set("outrunner:custom-models:deepseek", JSON.stringify(["ok-id", "bad id", 3]));
  assert.deepEqual(rememberedCustomModels("deepseek").map((m) => m.id), ["ok-id"]);
  store.set("outrunner:custom-models:deepseek", "{not json");
  assert.deepEqual(rememberedCustomModels("deepseek"), []);
});

test("Codex takes typed ids too, remembered apart from any provider's", () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  };
  assert.equal(takesTypedModels("codex"), true);
  assert.equal(takesTypedModels("zai"), true);
  assert.equal(takesTypedModels("claude"), false);
  assert.equal(takesTypedModels("outrunner"), false);
  rememberCustomModel("codex", "gpt-7-preview");
  rememberCustomModel("codex", "gpt-6-luna"); // listed already
  assert.deepEqual(rememberedCustomModels("codex"), [{ id: "gpt-7-preview", label: "gpt-7-preview", provider: "codex" }]);
  assert.deepEqual(rememberedCustomModels("openrouter"), []);
});
