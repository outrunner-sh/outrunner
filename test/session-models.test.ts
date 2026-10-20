import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentOf,
  defaultModel,
  matchModel,
  modelChoice,
  modelGroups,
  modelLabel,
  predatesProvider,
  requestedModel,
  setModelRequest,
  type ModelMenu,
} from "@/lib/runtime/session-models";
import { usableProviders } from "@/lib/providers/registry";

const OUTRUNNER_ONLY: ModelMenu = { outrunner: true, allowance: true, keys: [] };
const GROUPS = modelGroups(OUTRUNNER_ONLY);

test("a Claude account reply matches its family's alias", () => {
  assert.equal(matchModel(GROUPS, "claude-opus-5")?.id, "opus");
  assert.equal(matchModel(GROUPS, "claude-sonnet-5")?.id, "sonnet");
  assert.equal(matchModel(GROUPS, "claude-haiku-4-5-20251001")?.id, "haiku");
  assert.equal(matchModel(GROUPS, "sonnet")?.provider, "claude");
});

test("a reply from one of Outrunner's models matches its OpenRouter slug, not a Claude alias", () => {
  assert.deepEqual(matchModel(GROUPS, "z-ai/glm-5.3"), { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" });
  // OpenRouter's Sonnet is Outrunner's, though the name says Sonnet.
  assert.equal(matchModel(GROUPS, "anthropic/claude-sonnet-5")?.provider, "outrunner");
});

test("a model outside the menu matches none", () => {
  assert.equal(matchModel(GROUPS, "z-ai/glm-4.6"), undefined);
  assert.equal(matchModel(GROUPS, "claude-opusx"), undefined);
  assert.equal(matchModel(GROUPS, undefined), undefined);
});

test("the label drops Claude's release date only", () => {
  assert.equal(modelLabel("claude-opus-4-5-20250115"), "claude-opus-4-5");
  assert.equal(modelLabel("z-ai/glm-5.3"), "z-ai/glm-5.3");
});

test("the menu: Outrunner's where the server has them, each provider the user has a key for, Claude, then Codex", () => {
  const labels = (menu: ModelMenu) => modelGroups(menu).map((g) => g.label);
  assert.deepEqual(labels(OUTRUNNER_ONLY), ["Outrunner · included", "Claude account", "Codex"]);
  assert.deepEqual(labels({ ...OUTRUNNER_ONLY, allowance: false }), ["Outrunner", "Claude account", "Codex"]);
  // In the registry's order, whatever order the keys come in.
  assert.deepEqual(labels({ outrunner: true, allowance: true, keys: ["deepseek", "openrouter"] }), [
    "Outrunner · included",
    "OpenRouter · your key",
    "DeepSeek · your key",
    "Claude account",
    "Codex",
  ]);
  // No server key: Outrunner's models aren't offered, so nothing on the menu 503s.
  assert.deepEqual(labels({ outrunner: false, allowance: false, keys: [] }), ["Claude account", "Codex"]);

  const groups = modelGroups({ outrunner: true, allowance: false, keys: ["zai"] });
  assert.deepEqual(
    groups.map((g) => g.custom),
    [false, true, false, true],
    "only a provider on the user's key, and Codex, take typed ids",
  );
  assert.ok(groups[1].models.every((m) => m.provider === "zai"));
});

test("a new session's default: Outrunner's first model, on the user's OpenRouter key if saved, else the first key's", () => {
  assert.deepEqual(defaultModel(OUTRUNNER_ONLY), { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" });
  assert.equal(defaultModel({ ...OUTRUNNER_ONLY, keys: ["openrouter"] })?.provider, "openrouter");
  // A Z.ai key alone still starts a session without the user's Claude.
  assert.deepEqual(defaultModel({ outrunner: false, allowance: false, keys: ["zai", "moonshot"] }), {
    id: "glm-5.3",
    label: "GLM 5.3",
    provider: "zai",
  });
  assert.equal(defaultModel({ outrunner: false, allowance: false, keys: [] }), null);
});

test("a choice is checked per provider: Outrunner's and Claude's from their lists, a key's any id the agent takes", () => {
  assert.equal(modelChoice("outrunner", "z-ai/glm-5.3")?.label, "GLM 5.3");
  // The allowance pays for Outrunner's models only.
  assert.equal(modelChoice("outrunner", "openai/gpt-5"), null);
  assert.equal(modelChoice("claude", "opus")?.provider, "claude");
  assert.equal(modelChoice("claude", "claude-opus-5"), null);

  assert.deepEqual(modelChoice("deepseek", "deepseek-v4-pro"), { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek" });
  assert.deepEqual(modelChoice("openrouter", "openai/gpt-5[1m]"), { id: "openai/gpt-5[1m]", label: "openai/gpt-5[1m]", provider: "openrouter" });
  for (const bad of ["", "-rf", "a b", "x;rm", "$(id)", "m".repeat(101), 42, null]) {
    assert.equal(modelChoice("zai", bad), null, `took ${JSON.stringify(bad)}`);
  }
  for (const provider of ["anthropic-ish", "https://evil.example", "toString", undefined]) {
    assert.equal(modelChoice(provider, "glm-5.3"), null, `took provider ${String(provider)}`);
  }
});

test("a request names provider and model; a page from before providers named a key", () => {
  assert.equal(requestedModel({}), undefined);
  assert.equal(requestedModel(null), undefined);
  assert.deepEqual(requestedModel({ provider: "moonshot", model: "kimi-k3" })?.provider, "moonshot");
  assert.equal(requestedModel({ provider: "moonshot", model: "-x" }), null);
  // Before providers: "own" was the user's OpenRouter key; no key, Outrunner's.
  assert.equal(requestedModel({ model: "z-ai/glm-5.3", key: "own" })?.provider, "openrouter");
  assert.equal(requestedModel({ model: "z-ai/glm-5.3", key: "outrunner" })?.provider, "outrunner");
  assert.equal(requestedModel({ model: "z-ai/glm-5.3" })?.provider, "outrunner");
  assert.equal(requestedModel({ model: "opus" })?.provider, "claude");
  assert.equal(requestedModel({ model: "openai/gpt-5" }), null);
});

test("a model switches through its provider on the key that provider's holder gives", async () => {
  const asked: string[] = [];
  const keyFor = async (holder: string) => {
    asked.push(holder);
    return `key-of-${holder}-0123456789abcdef`;
  };
  assert.deepEqual(await setModelRequest({ id: "z-ai/glm-5.3", label: "", provider: "outrunner" }, keyFor), {
    model: "z-ai/glm-5.3",
    gateway: "openrouter",
    token: "key-of-outrunner-0123456789abcdef",
  });
  assert.deepEqual(await setModelRequest({ id: "glm-5.3", label: "", provider: "zai" }, keyFor), {
    model: "glm-5.3",
    gateway: "zai",
    token: "key-of-zai-0123456789abcdef",
  });
  assert.deepEqual(await setModelRequest({ id: "opus", label: "Opus", provider: "claude" }, keyFor), { model: "opus" });
  assert.deepEqual(asked, ["outrunner", "zai"], "no key asked for the user's own Claude");
});

test("a model offered by two is ticked on the provider it was picked on", () => {
  const groups = modelGroups({ outrunner: true, allowance: true, keys: ["openrouter"] });
  assert.equal(matchModel(groups, "z-ai/glm-5.3", "openrouter")?.provider, "openrouter");
  assert.equal(matchModel(groups, "z-ai/glm-5.3", "outrunner")?.provider, "outrunner");
  // No preference: the first offered.
  assert.equal(matchModel(groups, "z-ai/glm-5.3")?.provider, "outrunner");
});

test("an agent older than a provider is told apart from other refusals", () => {
  assert.equal(predatesProvider('unknown gateway "zai"'), true);
  assert.equal(predatesProvider("invalid model"), false);
  assert.equal(predatesProvider(undefined), false);
});

test("a saved key that can't be opened isn't offered, so it's never a new session's default", () => {
  const rows = [
    { provider: "deepseek", key_ciphertext: "ok" },
    { provider: "openrouter", key_ciphertext: "unreadable" },
    { provider: "retired-provider", key_ciphertext: "ok" },
    { provider: "zai", key_ciphertext: "ok" },
  ];
  const keys = usableProviders(rows, (row) => row.key_ciphertext === "ok");
  assert.deepEqual(keys, ["zai", "deepseek"], "the registry's order; unknown and unreadable dropped");
  // The unreadable OpenRouter key no longer wins over the server's key.
  assert.equal(defaultModel({ outrunner: true, allowance: true, keys })?.provider, "outrunner");
});

test("a running session's menu offers only what its agent runs", () => {
  const menu: ModelMenu = { outrunner: true, allowance: false, keys: ["zai"] };
  assert.deepEqual(
    modelGroups(menu, "claude").map((g) => g.provider),
    ["outrunner", "zai", "claude"],
  );
  assert.deepEqual(
    modelGroups(menu, "codex").map((g) => g.provider),
    ["codex"],
  );
  assert.equal(agentOf("codex"), "codex");
  for (const provider of ["outrunner", "claude", "openrouter", "anthropic"] as const) {
    assert.equal(agentOf(provider), "claude", provider);
  }
});

test("Codex takes its listed models and any id the agent takes, and switches with no key", async () => {
  assert.deepEqual(modelChoice("codex", "gpt-6-luna"), { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "codex" });
  assert.deepEqual(modelChoice("codex", "gpt-7"), { id: "gpt-7", label: "gpt-7", provider: "codex" });
  assert.equal(modelChoice("codex", "--dangerously-bypass-approvals-and-sandbox"), null);
  assert.deepEqual(requestedModel({ provider: "codex", model: "gpt-6-sol" })?.provider, "codex");
  // A key for Codex is its sign-in's (Settings → Providers → Codex), never a model's.
  const req = await setModelRequest(modelChoice("codex", "gpt-6-sol")!, () => {
    throw new Error("no key is asked for");
  });
  assert.deepEqual(req, { model: "gpt-6-sol" });
});
