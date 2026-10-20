import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOADOUT_MAX,
  loadoutDefault,
  loadoutModels,
  moveEntry,
  parseLoadout,
  searchModels,
  toggleEntry,
} from "@/lib/runtime/model-loadout";
import { modelGroups } from "@/lib/runtime/session-models";

const OPUS = { provider: "claude", id: "opus" } as const;
const LUNA = { provider: "codex", id: "gpt-6-luna" } as const;
const GLM = { provider: "zai", id: "glm-5.3" } as const;

test("a stored or requested loadout is made sound", () => {
  assert.deepEqual(
    parseLoadout({
      models: [OPUS, OPUS, { provider: "claude", id: "gpt-6" }, { provider: "nope", id: "x" }, LUNA, "junk"],
      default: LUNA,
    }),
    { models: [OPUS, LUNA], default: LUNA },
    "unknown and repeated entries dropped",
  );
  // A default that isn't one of its models is none.
  assert.deepEqual(parseLoadout({ models: [OPUS], default: LUNA }), { models: [OPUS], default: null });
  assert.deepEqual(parseLoadout(null), { models: [], default: null });
  const many = Array.from({ length: 30 }, (_, i) => ({ provider: "codex", id: `gpt-x${i}` }));
  assert.equal(parseLoadout({ models: many }).models.length, LOADOUT_MAX);
});

test("the picker shows what the menu offers now, in the loadout's order", () => {
  const loadout = parseLoadout({ models: [LUNA, GLM, OPUS], default: GLM });
  // No Z.ai key: its model is kept in the loadout but not shown, nor started on.
  const noKey = modelGroups({ outrunner: false, allowance: false, keys: [] });
  assert.deepEqual(loadoutModels(loadout, noKey).map((m) => m.id), ["gpt-6-luna", "opus"]);
  assert.equal(loadoutDefault(loadout, noKey), undefined);
  const withKey = modelGroups({ outrunner: false, allowance: false, keys: ["zai"] });
  assert.deepEqual(loadoutModels(loadout, withKey).map((m) => m.id), ["gpt-6-luna", "glm-5.3", "opus"]);
  assert.equal(loadoutDefault(loadout, withKey)?.id, "glm-5.3");
  // A typed id stays offered where its group takes typed ids.
  const typed = parseLoadout({ models: [{ provider: "codex", id: "gpt-7-preview" }] });
  assert.equal(loadoutModels(typed, noKey)[0]?.label, "gpt-7-preview");
});

test("picking, unpicking and ordering", () => {
  let loadout = toggleEntry(parseLoadout(null), OPUS);
  assert.deepEqual(loadout, { models: [OPUS], default: OPUS }, "the first picked is the default");
  loadout = toggleEntry(loadout, LUNA);
  loadout = moveEntry(loadout, LUNA, -1);
  assert.deepEqual(loadout.models, [LUNA, OPUS]);
  assert.deepEqual(moveEntry(loadout, LUNA, -1), loadout, "nothing before the first");
  loadout = toggleEntry(loadout, OPUS);
  assert.deepEqual(loadout, { models: [LUNA], default: null }, "the default goes with its model");
});

test("search finds a model by its name or its id", () => {
  const all = modelGroups({ outrunner: false, allowance: false, keys: [] }).flatMap((g) => g.models);
  assert.deepEqual(searchModels(all, "luna").map((m) => m.id), ["gpt-6-luna"]);
  assert.deepEqual(searchModels(all, "OPUS").map((m) => m.id), ["opus"]);
  assert.equal(searchModels(all, "  ").length, all.length);
});

test("a move passes over models the picker doesn't show now", () => {
  // GLM's key is gone: Opus and Luna are next to each other as the user sees them.
  const loadout = parseLoadout({ models: [OPUS, GLM, LUNA] });
  const visible = [OPUS, LUNA];
  assert.deepEqual(moveEntry(loadout, OPUS, 1, visible).models, [LUNA, GLM, OPUS]);
  assert.deepEqual(moveEntry(loadout, LUNA, -1, visible).models, [LUNA, GLM, OPUS]);
  assert.deepEqual(moveEntry(loadout, LUNA, 1, visible), loadout, "nothing shown after the last");
});
