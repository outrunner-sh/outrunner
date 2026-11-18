import assert from "node:assert/strict";
import { test } from "node:test";

import { modelsJson } from "@/lib/api/models";
import { EMPTY_LOADOUT } from "@/lib/runtime/model-loadout";
import { CLAUDE_MODELS, modelGroups, OUTRUNNER_MODELS } from "@/lib/runtime/session-models";

type Item = { id: string; provider: string; agents: string[]; efforts: string[]; default: boolean; default_effort: string | null; supports_images: boolean | null };

test("the models are the menu's, in its order, with the efforts each takes", () => {
  const groups = modelGroups({ outrunner: true, allowance: true, keys: [] }, ["claude"]);
  const { data, custom_providers } = modelsJson(groups, EMPTY_LOADOUT) as { data: Item[]; custom_providers: string[] };
  assert.deepEqual(data.map((m) => `${m.provider}/${m.id}`), [
    ...OUTRUNNER_MODELS.map((m) => `outrunner/${m.id}`),
    ...CLAUDE_MODELS.map((m) => `claude/${m.id}`),
  ]);
  const opus = data.find((m) => m.provider === "claude" && m.id === "opus")!;
  assert.deepEqual(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(opus.agents, ["claude"]);
  assert.equal(opus.supports_images, true);
  assert.deepEqual(data.find((m) => m.provider === "outrunner")!.efforts, []);
  assert.deepEqual(data.find((m) => m.provider === "outrunner")!.agents, ["claude", "codex"]);
  assert.deepEqual(custom_providers, []);
});

test("exactly one model is the default: the one a session named none starts on", () => {
  const groups = modelGroups({ outrunner: true, allowance: true, keys: [] }, ["claude"]);
  const { data } = modelsJson(groups, EMPTY_LOADOUT) as { data: Item[] };
  assert.equal(data.filter((m) => m.default).length, 1);
  const loadout = { models: [{ provider: "claude" as const, id: "sonnet", effort: "low" as const }], default: { provider: "claude" as const, id: "sonnet" } };
  const chosen = (modelsJson(groups, loadout) as { data: Item[] }).data.filter((m) => m.default);
  assert.deepEqual(chosen.map((m) => [m.id, m.default_effort]), [["sonnet", "low"]]);
});

test("a provider on the user's own key takes ids beyond its list", () => {
  const groups = modelGroups({ outrunner: false, allowance: false, keys: ["openrouter"] }, []);
  assert.deepEqual((modelsJson(groups, EMPTY_LOADOUT) as { custom_providers: string[] }).custom_providers, ["openrouter"]);
});

test("no model on offer is an empty list", () => {
  assert.deepEqual(modelsJson([], EMPTY_LOADOUT), { data: [], custom_providers: [], items: [] });
});
