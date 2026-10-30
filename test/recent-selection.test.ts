import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_LOADOUT } from "@/lib/runtime/model-loadout";
import { initialSelection } from "@/lib/runtime/selection";
import { modelGroups, OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import { lastSessionSelection, parseRecentSelection, recentSelectionFor, type RecentSelection } from "@/lib/session/recent-selection";
import { frame } from "@/test/browser/fixtures";
import { selectionMenu } from "@/test/browser/selection-fixtures";

const groups = modelGroups(selectionMenu, ["claude", "codex"]);
const codex: RecentSelection = { provider: "codex", id: "account-code", agent: "codex", effort: "low" };

test("recent account choice takes precedence over the Claude/GLM default with its exact effort", () => {
  assert.equal(initialSelection(groups, EMPTY_LOADOUT)?.agent, "claude");
  const selected = recentSelectionFor(groups, codex, ["claude", "codex"]);
  assert.deepEqual(selected, { model: selectionMenu.codexModels![0], agent: "codex", effort: "low" });
});

test("a shared provider keeps the harness used in the last session", () => {
  const selected = recentSelectionFor(groups, { ...codex, provider: "outrunner", id: OUTRUNNER_MODELS[0].id });
  assert.equal(selected?.agent, "codex");
  assert.equal(selected?.model.provider, "outrunner");
});

test("target restrictions and disconnected accounts fall back without rewriting the last selection", () => {
  const before = { ...codex };
  assert.equal(recentSelectionFor(groups, codex, ["claude"]), null);
  assert.equal(recentSelectionFor(groups, codex, undefined, "claude"), null);
  assert.equal(recentSelectionFor(modelGroups({ ...selectionMenu, codexModels: [] }, ["claude"]), codex), null);
  assert.deepEqual(codex, before);
});

test("current catalog capabilities validate remembered effort and preserve the model's own effort", () => {
  assert.equal(recentSelectionFor(groups, { ...codex, effort: "max" })?.effort, null);
  assert.equal(recentSelectionFor(groups, { ...codex, effort: null })?.effort, null);
});

test("cold starts use the user's latest saved model change, excluding other users and deleted sessions", () => {
  const base = frame.appData.workspaces[0];
  const saved = { model: selectionMenu.codexModels![0], effort: "low" as const };
  const rows = [
    { ...base, model: { model: OUTRUNNER_MODELS[0], effort: null } },
    { ...base, agent: "codex" as const, model: saved, updatedAt: "2026-10-30T10:00:00.001Z" },
    { ...base, model: { model: OUTRUNNER_MODELS[0], effort: null }, updatedAt: "2026-10-30T10:00:00Z" },
    { ...base, ownerId: "someone-else", updatedAt: "2026-10-31T00:00:00Z", model: saved },
    { ...base, status: "destroyed" as const, updatedAt: "2026-11-01T00:00:00Z", model: saved },
  ];
  assert.deepEqual(lastSessionSelection(rows, base.ownerId), codex);
  assert.equal(lastSessionSelection(rows, "new-user"), null);
  assert.equal(lastSessionSelection([base], base.ownerId), null);
});

test("damaged stored choices and incompatible provider/harness pairs are ignored", () => {
  assert.deepEqual(parseRecentSelection(codex), codex);
  for (const value of [null, {}, { ...codex, agent: "claude" }, { ...codex, provider: "unknown" }, { ...codex, effort: "ultra" }, { ...codex, effort: undefined }]) {
    assert.equal(parseRecentSelection(value), null);
  }
});
