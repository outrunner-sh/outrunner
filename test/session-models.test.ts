import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_IDS, type AgentConnection, type AgentId } from "@/lib/agents/registry";
import {
  agentOf,
  agentsFor,
  checkEffortApplied,
  connectedAccounts,
  costHint,
  defaultModel,
  EffortUnsupportedError,
  matchModel,
  modelChoice,
  modelGroups,
  modelLabel,
  onCodexGateway,
  OUTRUNNER_MODELS,
  parseAgentConnections,
  predatesProvider,
  recordedModel,
  requestedAgent,
  requestedEffort,
  requestedModel,
  runsOnOwnAccount,
  setModelRequest,
  takesEffort,
  type ModelMenu,
} from "@/lib/runtime/session-models";
import { usableProviders } from "@/lib/providers/registry";

const OUTRUNNER_ONLY: ModelMenu = { outrunner: true, allowance: true, keys: [] };
const GROUPS = modelGroups(OUTRUNNER_ONLY, AGENT_IDS);

test("a Claude account reply matches its family's alias", () => {
  assert.equal(matchModel(GROUPS, "claude-opus-5")?.id, "opus");
  assert.equal(matchModel(GROUPS, "claude-sonnet-5")?.id, "sonnet");
  assert.equal(matchModel(GROUPS, "claude-haiku-4-5-20251001")?.id, "haiku");
  assert.equal(matchModel(GROUPS, "sonnet")?.provider, "claude");
});

test("a reply from one of Outrunner's models matches its OpenRouter slug, not a Claude alias", () => {
  assert.deepEqual(matchModel(GROUPS, "z-ai/glm-5.3"), { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" });
  assert.equal(matchModel(GROUPS, "moonshotai/kimi-k3")?.label, "Kimi K3");
  assert.equal(matchModel(GROUPS, "deepseek/deepseek-v4.1-flash")?.label, "DeepSeek V4.1 Flash");
});

test("Outrunner's key runs only its own models: Claude through OpenRouter is no longer one", () => {
  // A session recorded on one before reads as on none, and a request for it
  // is refused, so the shared key isn't spent on a model it no longer offers.
  assert.equal(modelChoice("outrunner", "anthropic/claude-opus-5.5"), null);
  assert.equal(recordedModel("outrunner", "anthropic/claude-sonnet-5", null), null);
  assert.equal(matchModel(GROUPS, "anthropic/claude-sonnet-5"), undefined);
});

test("every one of Outrunner's models says what it costs against the default; nothing else does", () => {
  assert.deepEqual(OUTRUNNER_MODELS.map(costHint), ["1x", "8.5x", "0.27x"]);
  // The same slug on the user's own OpenRouter key is theirs to pay for.
  assert.equal(costHint({ ...OUTRUNNER_MODELS[0], provider: "openrouter" }), null);
  assert.equal(costHint({ id: "opus", label: "Opus", provider: "claude" }), null);
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
  const labels = (menu: ModelMenu) => modelGroups(menu, AGENT_IDS).map((g) => g.label);
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

  const groups = modelGroups({ outrunner: true, allowance: false, keys: ["zai"] }, AGENT_IDS);
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
  const groups = modelGroups({ outrunner: true, allowance: true, keys: ["openrouter"] }, AGENT_IDS);
  assert.equal(matchModel(groups, "z-ai/glm-5.3", "openrouter")?.provider, "openrouter");
  assert.equal(matchModel(groups, "z-ai/glm-5.3", "outrunner")?.provider, "outrunner");
  // No preference: the first offered.
  assert.equal(matchModel(groups, "z-ai/glm-5.3")?.provider, "outrunner");
});

test("an agent older than a provider is told apart from other refusals", () => {
  assert.equal(predatesProvider('unknown gateway "zai"'), true);
  // An agent from before Codex ran through a gateway, as it refused one.
  assert.equal(predatesProvider("a Codex session runs on OpenAI's models directly and can't use a gateway"), true);
  // This one's refusal of a gateway serving only Anthropic's API is no age.
  assert.equal(
    predatesProvider("a Codex session runs on OpenAI's models directly, or through OpenRouter, and can't use this gateway"),
    false,
  );
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
    modelGroups(menu, AGENT_IDS, "claude").map((g) => g.provider),
    ["outrunner", "zai", "claude"],
  );
  // Codex runs Outrunner's models too (through OpenRouter's OpenAI API),
  // but no key's: those are reached through an Anthropic API.
  assert.deepEqual(
    modelGroups(menu, AGENT_IDS, "codex").map((g) => g.provider),
    ["outrunner", "codex"],
  );
  assert.deepEqual(
    modelGroups({ outrunner: false, allowance: false, keys: ["openrouter"] }, AGENT_IDS, "codex").map((g) => g.provider),
    ["codex"],
  );
  assert.equal(agentOf("codex"), "codex");
  for (const provider of ["outrunner", "claude", "openrouter", "anthropic"] as const) {
    assert.equal(agentOf(provider), "claude", provider);
  }
});

test("a session asked to run an agent runs it where that agent runs the model, and its model's own elsewhere", () => {
  assert.deepEqual(agentsFor("outrunner"), ["claude", "codex"]);
  assert.deepEqual(agentsFor("codex"), ["codex"]);
  for (const provider of ["claude", "openrouter", "anthropic", "zai", "moonshot", "deepseek"] as const) {
    assert.deepEqual(agentsFor(provider), ["claude"], provider);
  }
  // Outrunner's models in Codex (onboarding's "Codex → Outrunner's models").
  assert.equal(agentOf("outrunner", "codex"), "codex");
  assert.equal(agentOf("outrunner", "claude"), "claude");
  // An agent that can't run the model is never what runs it.
  assert.equal(agentOf("claude", "codex"), "claude");
  assert.equal(agentOf("openrouter", "codex"), "claude");
  assert.equal(agentOf("codex", "claude"), "codex");
  // Every agent a provider names runs it as the session's.
  for (const provider of ["outrunner", "claude", "codex", "openrouter"] as const) {
    for (const agent of agentsFor(provider)) assert.equal(agentOf(provider, agent), agent, `${provider} in ${agent}`);
  }
});

test("only Codex on a model it doesn't own needs an agent that runs Codex through a gateway", () => {
  assert.equal(onCodexGateway("codex", { provider: "outrunner" }), true);
  assert.equal(onCodexGateway("codex", { provider: "codex" }), false);
  assert.equal(onCodexGateway("claude", { provider: "outrunner" }), false);
  assert.equal(onCodexGateway("claude", { provider: "openrouter" }), false);
});

test("a request's agent is one there is, none, or refused", () => {
  assert.equal(requestedAgent({ agent: "codex" }), "codex");
  assert.equal(requestedAgent({ agent: "claude" }), "claude");
  assert.equal(requestedAgent({}), undefined);
  assert.equal(requestedAgent({ agent: null }), undefined);
  assert.equal(requestedAgent(null), undefined);
  for (const bad of ["Codex", "gemini", "", 1]) assert.equal(requestedAgent({ agent: bad }), null, String(bad));
});

test("a Codex session on Outrunner's model switches on Outrunner's key, as a Claude Code one does", async () => {
  const keyFor = async (holder: string) => `key-of-${holder}-0123456789`;
  assert.deepEqual(await setModelRequest(modelChoice("outrunner", "moonshotai/kimi-k3")!, keyFor, "high"), {
    model: "moonshotai/kimi-k3",
    gateway: "openrouter",
    token: "key-of-outrunner-0123456789",
  });
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

test("an effort goes only with a model that takes one", async () => {
  const keyFor = async () => "key-0123456789abcdef";
  assert.equal(takesEffort({ provider: "claude", id: "opus" }), true);
  assert.equal(takesEffort({ provider: "codex", id: "gpt-7-preview" }), true, "a typed Codex id too");
  // Haiku has none; a gateway's model runs at its own, Claude's family or not.
  assert.equal(takesEffort({ provider: "claude", id: "haiku" }), false);
  assert.equal(takesEffort({ provider: "openrouter", id: "anthropic/claude-opus-5.5" }), false);

  assert.deepEqual(await setModelRequest(modelChoice("claude", "opus")!, keyFor, "xhigh"), { model: "opus", effort: "xhigh" });
  assert.deepEqual(await setModelRequest(modelChoice("claude", "haiku")!, keyFor, "xhigh"), { model: "haiku" });
  assert.equal((await setModelRequest(modelChoice("outrunner", "z-ai/glm-5.3")!, keyFor, "max")).effort, undefined);
  assert.deepEqual(await setModelRequest(modelChoice("codex", "gpt-6-sol")!, keyFor, null), { model: "gpt-6-sol" });
});

test("a request's effort is a level, none, or refused", () => {
  assert.equal(requestedEffort({ effort: "high" }), "high");
  assert.equal(requestedEffort({}), undefined);
  assert.equal(requestedEffort({ effort: null }), undefined);
  assert.equal(requestedEffort(null), undefined);
  for (const bad of ["ultra", "--max", "", 3]) assert.equal(requestedEffort({ effort: bad }), null, String(bad));
});

test("an agent that doesn't say it applied the effort predates efforts", () => {
  // Asked for none: any answer will do.
  checkEffortApplied({ model: "opus" }, { result: "opus" });
  checkEffortApplied({ model: "opus", effort: "max" }, { result: "opus", effort: "max" });
  for (const answer of [{ result: "opus" }, { result: "opus", effort: "" }, undefined, "opus"]) {
    assert.throws(() => checkEffortApplied({ model: "opus", effort: "max" }, answer), EffortUnsupportedError);
  }
});

test("the user's own Claude and Codex are offered only where connected", () => {
  const labels = (accounts: AgentId[], agent?: AgentId) =>
    modelGroups(OUTRUNNER_ONLY, accounts, agent).map((g) => g.label);
  // Nothing connected: Outrunner's alone, and its first model is the default.
  assert.deepEqual(labels([]), ["Outrunner · included"]);
  assert.deepEqual(labels(["codex"]), ["Outrunner · included", "Codex"]);
  // A running Codex session whose Codex was disconnected can still switch to
  // Outrunner's models, which need no account of the user's.
  assert.deepEqual(labels([], "codex"), ["Outrunner · included"]);
  assert.deepEqual(labels(["codex"], "codex"), ["Outrunner · included", "Codex"]);
  assert.deepEqual(modelGroups({ outrunner: false, allowance: false, keys: [] }, [], "codex"), []);
});

test("where an account is connected: everywhere on a saved credential, on the Mac by its own login", () => {
  const connections = (claude: AgentConnection, codex: AgentConnection) => ({ claude, codex });
  const saved: AgentConnection = { cloud: true, local: true };
  const none: AgentConnection = { cloud: false, local: false };
  const macLogin: AgentConnection = { cloud: false, local: "mac-login" };
  const loggedIn = (who: AgentId[]) => (agent: AgentId) => who.includes(agent);

  // Disconnected: nowhere, whatever the Mac is logged in to.
  assert.deepEqual(connectedAccounts(connections(none, none), "cloud", loggedIn(AGENT_IDS)), []);
  assert.deepEqual(connectedAccounts(connections(none, none), "local", loggedIn(AGENT_IDS)), []);
  // Saved: everywhere, the Mac's login aside.
  assert.deepEqual(connectedAccounts(connections(saved, none), "cloud", loggedIn([])), ["claude"]);
  assert.deepEqual(connectedAccounts(connections(saved, none), "local", loggedIn([])), ["claude"]);
  // The Mac's own login: on the Mac only, and only where it is logged in.
  assert.deepEqual(connectedAccounts(connections(macLogin, macLogin), "cloud", loggedIn(AGENT_IDS)), []);
  assert.deepEqual(connectedAccounts(connections(macLogin, macLogin), "local", loggedIn(["codex"])), ["codex"]);
});

test("a server that says nothing of connections is taken to have them all", () => {
  const all = { claude: { cloud: true, local: true }, codex: { cloud: true, local: true } };
  assert.deepEqual(parseAgentConnections(undefined), all);
  assert.deepEqual(parseAgentConnections({ claude: { cloud: "yes" } }), all);
  assert.deepEqual(
    parseAgentConnections({ claude: { cloud: false, local: false }, codex: { cloud: false, local: "mac-login" } }),
    { claude: { cloud: false, local: false }, codex: { cloud: false, local: "mac-login" } },
  );
});

test("only Claude's and Codex's own models run on the user's account", () => {
  assert.equal(runsOnOwnAccount({ provider: "claude" }), true);
  assert.equal(runsOnOwnAccount({ provider: "codex" }), true);
  assert.equal(runsOnOwnAccount({ provider: "outrunner" }), false);
  assert.equal(runsOnOwnAccount({ provider: "anthropic" }), false);
});

test("a row's recorded model is checked as a request's choice is", () => {
  assert.deepEqual(recordedModel("outrunner", "z-ai/glm-5.3", null), { model: OUTRUNNER_MODELS[0], effort: null });
  assert.deepEqual(recordedModel("claude", "opus", "max"), { model: modelChoice("claude", "opus"), effort: "max" });
  // A model typed in on the user's own key.
  assert.deepEqual(recordedModel("zai", "glm-9", null), { model: { id: "glm-9", label: "glm-9", provider: "zai" }, effort: null });
  // An effort this release doesn't know runs at the model's own.
  assert.deepEqual(recordedModel("claude", "opus", "turbo"), { model: modelChoice("claude", "opus"), effort: null });
  // None recorded (a session from before the columns), or one no longer offered.
  assert.equal(recordedModel(null, null, null), null);
  assert.equal(recordedModel(undefined, undefined, undefined), null);
  assert.equal(recordedModel("outrunner", "z-ai/glm-4", null), null);
  assert.equal(recordedModel("gemini", "flash", null), null);
});
