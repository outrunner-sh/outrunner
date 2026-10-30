import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSelection, rememberedChatSelection } from "@/lib/session/chat-selection";
import { codexCatalog } from "@/lib/codex/model-catalog";
import { withOrgDefault } from "@/lib/orgs/defaults";
import { parseLoadout, setEntryAgent, setEntryEffort } from "@/lib/runtime/model-loadout";
import { creationSelection, eligibleHarnesses, groupsForHarness, initialSelection, selectionForHarness } from "@/lib/runtime/selection";
import { modelChoice, modelGroups, setModelRequest, type SessionModel } from "@/lib/runtime/session-models";
import { recordedModelRequest, startingModel } from "@/lib/runtime/model-switch";

// Deliberately fictitious catalog IDs: prove this path is catalog-driven.
const native = { models: [
  { slug: "account-code", display_name: "Account coding model", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }], default_reasoning_level: "low", input_modalities: ["text", "image"] },
  { slug: "account-text", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }], input_modalities: ["text"] },
  { slug: "hidden", visibility: "hide" }, { slug: "--invalid", visibility: "list" },
] };
const catalog = codexCatalog(native);
const groups = modelGroups({ outrunner: true, allowance: true, keys: ["zai"], codexModels: catalog }, ["claude", "codex"]);
const empty = parseLoadout(null);
const preference = parseLoadout({ models: [{ provider: "codex", id: "account-code", effort: "high" }], default: { provider: "codex", id: "account-code" } });

test("native catalog supplies exact model IDs, visibility, runtime-compatible effort and image capabilities", () => {
  assert.deepEqual(catalog.map((m) => m.id), ["account-code", "account-text"]);
  assert.deepEqual(catalog[0].efforts, ["low", "high"]);
  assert.equal(catalog[0].defaultEffort, "low");
  assert.equal(catalog[1].supportsImages, false);
  assert.deepEqual(codexCatalog({ models: "wrong" }), []);
});
test("only eligible implemented harnesses are offered for the target", () => {
  assert.deepEqual(eligibleHarnesses(groups), ["claude", "codex"]);
  assert.deepEqual(eligibleHarnesses(groups, ["claude"]), ["claude"]);
  assert.deepEqual(eligibleHarnesses(modelGroups({ outrunner: false, allowance: false, keys: ["zai"], codexModels: [] }, [])), ["claude"]);
  assert.deepEqual(groupsForHarness(groups, "codex").map((g) => g.provider), ["outrunner", "codex"]);
});
test("explicit choice precedes personal, personal precedes org, unset uses an eligible supported model", () => {
  const org = { provider: "claude" as const, id: "sonnet", effort: "medium" as const };
  assert.equal(creationSelection(groups, withOrgDefault(preference, org), { defaultEffort: true }).model.id, "account-code");
  assert.equal(creationSelection(groups, withOrgDefault(empty, org), { defaultEffort: true }).model.id, "sonnet");
  assert.equal(creationSelection(groups, preference, { model: modelChoice("claude", "haiku")!, effort: null }).model.id, "haiku");
  assert.equal(creationSelection(groups, empty, {}).model.provider, "outrunner");
});
test("an unavailable saved preference is preserved, while a submitted unavailable choice fails closed", () => {
  const before = JSON.stringify(preference);
  const onlyClaude = modelGroups({ outrunner: false, allowance: false, keys: [], codexModels: [] }, ["claude"]);
  assert.equal(initialSelection(onlyClaude, preference)?.model.provider, "claude");
  assert.equal(JSON.stringify(preference), before);
  assert.throws(() => creationSelection(onlyClaude, preference, { model: catalog[0] }), /isn't available/);
  assert.throws(() => creationSelection(groups, preference, { model: catalog[0], agent: "claude" }), /selected harness/);
  assert.throws(() => creationSelection(groups, empty, { agent: "codex", supported: ["claude"] }), /available|harness/);
});
test("harness switches reconcile incompatible effort and restore a valid per-harness pick", () => {
  const remembered = { model: catalog[1], effort: "high" as const };
  assert.equal(selectionForHarness(groups, empty, "codex", remembered)?.effort, null);
  assert.equal(selectionForHarness(groups, empty, "codex", { ...remembered, effort: "medium" })?.effort, "medium");
  assert.equal(selectionForHarness(groupsForHarness(groups, "claude"), empty, "claude", remembered)?.model.provider, "claude");
});
test("saved shared-model harness uses existing JSON preferences without changing settings scope", () => {
  let loadout = parseLoadout({ models: [{ provider: "outrunner", id: "z-ai/glm-5.3" }], default: { provider: "outrunner", id: "z-ai/glm-5.3" } });
  loadout = parseLoadout(setEntryAgent(loadout, loadout.models[0], "codex"));
  assert.equal(initialSelection(groups, loadout)?.agent, "codex");
  assert.equal(initialSelection(groups, loadout, undefined, ["claude"])?.agent, "claude");
  assert.equal(creationSelection(groups, loadout, { defaultEffort: true }).agent, "codex");
  const own = parseLoadout({ models: [{ provider: "claude", id: "opus", effort: "high", agent: "claude" }], default: { provider: "claude", id: "opus" } });
  assert.equal(parseLoadout(setEntryEffort(own, own.models[0], "low")).default?.effort, "low");
});
test("catalog-verified choice reaches runtime request and recorded result unchanged", async () => {
  const selected = creationSelection(groups, preference, { defaultEffort: true });
  let sent: unknown;
  const stored = await startingModel({ model: selected.model, effort: selected.effort ?? undefined, hasClaude: false, fallback: null,
    keyFor: async () => { throw new Error("An account model must not borrow a provider key"); },
    setModel: async (request) => { sent = request; return { model: request.model, effort: request.effort }; },
  });
  assert.deepEqual(sent, { model: "account-code", effort: "high" });
  assert.equal(selected.agent, "codex");
  assert.deepEqual(stored, { model: catalog[0], effort: "high" });
  assert.throws(() => creationSelection(groups, preference, { model: catalog[1], effort: "high" }), /effort/);
});
test("unknown capability defaults and resumed explicit effort are honest", async () => {
  const unknown: SessionModel = { id: "custom-model", label: "Custom", provider: "codex" };
  assert.deepEqual(await setModelRequest(unknown, async () => "unused", "max"), { model: "custom-model" });
  assert.deepEqual(await recordedModelRequest({ model: unknown, effort: "high" }, async () => "unused"), { model: "custom-model", effort: "high" });
});

test("forks keep source selections on the same harness and resolve compatible defaults on another", () => {
  const source = { agent: "codex" as const, model: { model: catalog[0], effort: "high" as const } };
  assert.deepEqual(chatSelection(source, "codex", groups, empty), source.model);
  const fork = chatSelection(source, "claude", groups, preference);
  assert.equal(fork?.model.provider, "claude");
  assert.equal(fork?.effort, "high");
});

test("fresh chats keep the active saved setup, then the latest setup for an explicitly chosen harness", () => {
  const oldClaude = { model: modelChoice("claude", "haiku")!, effort: "low" as const };
  const latestClaude = { model: modelChoice("claude", "opus")!, effort: "high" as const };
  const activeCodex = { agent: "codex" as const, model: { model: catalog[0], effort: "low" as const } };
  const chats = [
    { agent: "claude" as const, model: oldClaude },
    activeCodex,
    { agent: "claude" as const, model: latestClaude },
  ];
  assert.deepEqual(rememberedChatSelection(activeCodex, "codex", chats), activeCodex.model);
  assert.deepEqual(rememberedChatSelection(activeCodex, "claude", chats), latestClaude);
  assert.equal(rememberedChatSelection({ agent: "codex", model: null }, "codex", []), undefined);
});

test("an org harness default applies when a personal loadout has that model but no default or harness choice", () => {
  const mine = parseLoadout({ models: [{ provider: "outrunner", id: "z-ai/glm-5.3" }] });
  const combined = withOrgDefault(mine, { provider: "outrunner", id: "z-ai/glm-5.3", agent: "codex" });
  assert.equal(initialSelection(groups, combined)?.agent, "codex");
  assert.equal(mine.models[0].agent, undefined);
});

test("an unset default preserves canonical own-OpenRouter billing precedence", () => {
  const offered = modelGroups({ outrunner: true, allowance: true, keys: ["openrouter"], codexModels: catalog }, ["claude", "codex"]);
  assert.equal(initialSelection(offered, empty)?.model.provider, "openrouter");
  assert.equal(creationSelection(offered, empty, { defaultEffort: true }).model.provider, "openrouter");
});
