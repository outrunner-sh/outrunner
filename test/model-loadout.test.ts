import assert from "node:assert/strict";
import { test } from "node:test";

import {
  connectOffers,
  effortOnPick,
  LOADOUT_MAX,
  loadoutDefault,
  loadoutEffort,
  loadoutModels,
  moveEntry,
  parseLoadout,
  searchModels,
  setEntryEffort,
  toggleEntry,
} from "@/lib/runtime/model-loadout";
import { AGENT_IDS } from "@/lib/agents/registry";
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
  const noKey = modelGroups({ outrunner: false, allowance: false, keys: [] }, AGENT_IDS);
  assert.deepEqual(loadoutModels(loadout, noKey).map((m) => m.id), ["gpt-6-luna", "opus"]);
  assert.equal(loadoutDefault(loadout, noKey), undefined);
  const withKey = modelGroups({ outrunner: false, allowance: false, keys: ["zai"] }, AGENT_IDS);
  assert.deepEqual(loadoutModels(loadout, withKey).map((m) => m.id), ["gpt-6-luna", "glm-5.3", "opus"]);
  assert.equal(loadoutDefault(loadout, withKey)?.id, "glm-5.3");
  // Claude not connected: Opus is kept too, but not shown.
  const noClaude = modelGroups({ outrunner: false, allowance: false, keys: [] }, ["codex"]);
  assert.deepEqual(loadoutModels(loadout, noClaude).map((m) => m.id), ["gpt-6-luna"]);
  // A typed id stays offered where its group takes typed ids.
  const typed = parseLoadout({ models: [{ provider: "codex", id: "gpt-7-preview" }] });
  assert.equal(loadoutModels(typed, noKey)[0]?.label, "gpt-7-preview");
});

test("picking, unpicking and ordering", () => {
  let loadout = toggleEntry(parseLoadout(null), OPUS);
  const opusHigh = { ...OPUS, effort: "high" };
  assert.deepEqual(loadout, { models: [opusHigh], default: opusHigh }, "the first picked is the default, at high effort");
  assert.deepEqual(toggleEntry(loadout, GLM).models[1], GLM, "a model that takes no effort is added without one");
  loadout = toggleEntry(loadout, LUNA);
  loadout = moveEntry(loadout, LUNA, -1);
  assert.deepEqual(loadout.models, [LUNA, opusHigh]);
  assert.deepEqual(moveEntry(loadout, LUNA, -1), loadout, "nothing before the first");
  loadout = toggleEntry(loadout, OPUS);
  assert.deepEqual(loadout, { models: [LUNA], default: null }, "the default goes with its model");
});

test("search finds a model by its name or its id", () => {
  const all = modelGroups({ outrunner: false, allowance: false, keys: [] }, AGENT_IDS).flatMap((g) => g.models);
  assert.deepEqual(searchModels(all, "luna").map((m) => m.id), ["gpt-6-luna"]);
  assert.deepEqual(searchModels(all, "OPUS").map((m) => m.id), ["opus"]);
  assert.equal(searchModels(all, "  ").length, all.length);
});

test("a search keeps offering to connect the agent whose models it is for", () => {
  // Codex not connected: "gpt" is a search for its models, whatever else matches.
  assert.deepEqual(connectOffers(["codex"], "gpt", 0), ["codex"]);
  assert.deepEqual(connectOffers(["codex"], "GPT", 3), ["codex"]);
  assert.deepEqual(connectOffers(["claude", "codex"], "codex", 1), ["codex"]);
  assert.deepEqual(connectOffers(["claude", "codex"], "sonnet", 2), ["claude"]);
  // A search that found other models, and none of theirs: not offered.
  assert.deepEqual(connectOffers(["claude", "codex"], "glm", 1), []);
  // One that found nothing offers every agent there is to connect.
  assert.deepEqual(connectOffers(["claude", "codex"], "zzz", 0), ["claude", "codex"]);
  assert.deepEqual(connectOffers(["claude"], "  ", 5), ["claude"], "no search: all of them");
});

test("a move passes over models the picker doesn't show now", () => {
  // GLM's key is gone: Opus and Luna are next to each other as the user sees them.
  const loadout = parseLoadout({ models: [OPUS, GLM, LUNA] });
  const visible = [OPUS, LUNA];
  assert.deepEqual(moveEntry(loadout, OPUS, 1, visible).models, [LUNA, GLM, OPUS]);
  assert.deepEqual(moveEntry(loadout, LUNA, -1, visible).models, [LUNA, GLM, OPUS]);
  assert.deepEqual(moveEntry(loadout, LUNA, 1, visible), loadout, "nothing shown after the last");
});

test("each loadout model keeps the effort it runs at, where it takes one", () => {
  const HAIKU = { provider: "claude", id: "haiku" } as const;
  const loadout = parseLoadout({
    models: [
      { ...OPUS, effort: "xhigh" },
      { ...LUNA, effort: "ultra" }, // not a level
      { ...HAIKU, effort: "high" }, // current alias supports effort
      { ...GLM, effort: "high" }, // a gateway's runs at its own
    ],
  });
  assert.deepEqual(loadout.models, [{ ...OPUS, effort: "xhigh" }, LUNA, { ...HAIKU, effort: "high" }, GLM]);
  assert.equal(loadoutEffort(loadout, OPUS), "xhigh");
  assert.equal(loadoutEffort(loadout, LUNA), undefined);

  // Picked, each runs at its loadout's effort, its own where it has none
  // there, and high where it isn't in the loadout.
  assert.equal(effortOnPick(loadout, OPUS), "xhigh");
  assert.equal(effortOnPick(loadout, LUNA), null);
  assert.equal(effortOnPick(loadout, { provider: "codex", id: "gpt-6-sol" }), null);
  assert.equal(effortOnPick(undefined, OPUS), "high");

  const knownLuna = { ...LUNA, efforts: ["low" as const] };
  const set = setEntryEffort(loadout, knownLuna, "low");
  assert.equal(loadoutEffort(set, LUNA), "low");
  assert.deepEqual(setEntryEffort(set, knownLuna, null).models[1], LUNA, "null goes back to the model's own");
  assert.deepEqual(setEntryEffort(loadout, GLM, "max"), loadout, "a model that takes none is left");
  assert.deepEqual(setEntryEffort(loadout, { provider: "codex", id: "gpt-6-sol" }, "max"), loadout, "nor one not in it");
});
