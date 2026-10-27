/**
 * The models a session can run, and who serves each: Outrunner (its models,
 * on Outrunner's key and the user's allowance), the user's own Claude, a
 * provider on a key of the user's own (Settings → Providers), or Codex. A
 * choice is always both, a provider and a model, from the menu to the agent,
 * and the provider says which agents can run it: Codex runs Codex's models,
 * Claude Code every other, and either runs Outrunner's. Imports only the
 * registries, so it unit-tests without React or a session.
 */

import { type AgentConnection, type AgentId, AGENT_IDS, isAgentId, type RunTarget } from "@/lib/agents/registry";
import { isProviderId, PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** Who serves a model. */
export type ModelProvider = "outrunner" | "claude" | "codex" | ProviderId;

/** `id` is the provider's name for the model: a Claude alias, an OpenRouter
 *  slug, or a provider's own. */
export type SessionModel = { id: string; label: string; provider: ModelProvider };

/** `custom`: the group takes a model id typed in, as well as its list. */
export type ModelGroup = { label: string; provider: ModelProvider; models: SessionModel[]; custom: boolean };

/** Outrunner's models, through OpenRouter on Outrunner's key; the first is a
 *  new session's default. Exact OpenRouter slugs, so the menu ticks what a
 *  reply reports. Only these run on it: the allowance pays for them. */
export const OUTRUNNER_MODELS: SessionModel[] = [
  { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "outrunner" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", provider: "outrunner" },
];

/** What each of Outrunner's models costs, as a multiple of the default's
 *  (GLM 5.3): OpenRouter's output price, which most of a coding session's
 *  bill is, as of 2026-10-22. Update with the list, and when OpenRouter's
 *  prices move. */
const OUTRUNNER_COST: Record<string, number> = {
  "z-ai/glm-5.3": 1, // $1.40 per million output tokens
  "moonshotai/kimi-k3": 8.5, // $11.94
  "deepseek/deepseek-v4.1-flash": 0.27, // $0.375
};

/** The picker's cost hint for `model` ("8.5x"): only Outrunner's models have
 *  one, as only they draw on Outrunner's key; the user pays for the rest. */
export function costHint(model: SessionModel): string | null {
  if (model.provider !== "outrunner") return null;
  const cost = OUTRUNNER_COST[model.id];
  return cost === undefined ? null : `${cost}x`;
}

/** What a session on the user's Claude runs when no model is picked: the
 *  newest Opus, at DEFAULT_EFFORT, rather than Claude Code's own default. */
export const CLAUDE_DEFAULT_MODEL: SessionModel = { id: "opus", label: "Opus", provider: "claude" };

/** The user's own Claude. Aliases, so each is the newest of its family without
 *  a release here. */
export const CLAUDE_MODELS: SessionModel[] = [
  CLAUDE_DEFAULT_MODEL,
  { id: "sonnet", label: "Sonnet", provider: "claude" },
  { id: "haiku", label: "Haiku", provider: "claude" },
];

/** Codex's models, on however the user signs Codex in (Settings → Providers →
 *  Codex): OpenAI's names, as on its API. */
export const CODEX_MODELS: SessionModel[] = PROVIDERS.openai.models.map((m) => ({ ...m, provider: "codex" }));

/** The agents that can run a provider's models, the one a session runs when
 *  it names none first: Codex alone runs Codex's models, both run
 *  Outrunner's (Codex through OpenRouter's OpenAI API, Claude Code through
 *  its Anthropic one), and Claude Code alone the rest, which are reached
 *  through an Anthropic API only. A session keeps its agent: its model can
 *  change only to another its agent runs. */
export function agentsFor(provider: ModelProvider): readonly AgentId[] {
  if (provider === "codex") return ["codex"];
  if (provider === "outrunner") return ["claude", "codex"];
  return ["claude"];
}

/** The agent a new session on a provider's models runs: `preferred` (one the
 *  session was asked to run) where it runs them, else the provider's first. */
export function agentOf(provider: ModelProvider, preferred?: AgentId): AgentId {
  const agents = agentsFor(provider);
  return preferred && agents.includes(preferred) ? preferred : agents[0];
}

/** Whether a session runs Codex through a gateway (Outrunner's models), which
 *  only an agent with the `codex-gateway` feature does. */
export function onCodexGateway(agent: AgentId, model: { provider: ModelProvider }): boolean {
  return agent === "codex" && model.provider !== "codex";
}

/** A request body's agent: undefined when it names none, null when it names
 *  one that isn't an agent. */
export function requestedAgent(body: { agent?: unknown } | null): AgentId | null | undefined {
  if (body?.agent === undefined || body.agent === null) return undefined;
  return isAgentId(body.agent) ? body.agent : null;
}

/** Whether `model` runs on the user's own account of its agent (their
 *  Claude, or Codex's sign-in), rather than on a key Claude Code is pointed at. */
export function runsOnOwnAccount(model: { provider: ModelProvider }): boolean {
  return model.provider === "claude" || model.provider === "codex";
}

/** Connected everywhere: what a menu assumes of a server from before it
 *  said, or one it couldn't reach, so it offers what it always did. */
const ASSUMED_CONNECTED: AgentConnection = { cloud: true, local: true };

/** The server's `agents` (GET /api/outrunner-models), each made sound; an
 *  agent it says nothing sound of is assumed connected. */
export function parseAgentConnections(raw: unknown): Record<AgentId, AgentConnection> {
  const parse = (value: unknown): AgentConnection => {
    if (!value || typeof value !== "object") return ASSUMED_CONNECTED;
    const { cloud, local } = value as { cloud?: unknown; local?: unknown };
    if (typeof cloud !== "boolean" || (typeof local !== "boolean" && local !== "mac-login")) return ASSUMED_CONNECTED;
    return { cloud, local };
  };
  const agents = raw && typeof raw === "object" ? (raw as Partial<Record<AgentId, unknown>>) : {};
  return { claude: parse(agents.claude), codex: parse(agents.codex) };
}

/** The agents whose own accounts sessions on `target` can run on: where
 *  they are connected, and on the Mac, through its own login, where
 *  `macLoggedIn` says the agent's CLI is logged in there. */
export function connectedAccounts(
  connections: Record<AgentId, AgentConnection>,
  target: RunTarget,
  macLoggedIn: (agent: AgentId) => boolean,
): AgentId[] {
  return AGENT_IDS.filter((agent) => {
    const connection = connections[agent];
    if (target === "cloud") return connection.cloud;
    return connection.local === "mac-login" ? macLoggedIn(agent) : connection.local;
  });
}

/** The listed models on the user's key for `provider`. */
export function providerModels(provider: ProviderId): SessionModel[] {
  return PROVIDERS[provider].models.map((m) => ({ ...m, provider }));
}

/** What a user's menu is built from (GET /api/outrunner-models): whether the
 *  server runs Outrunner's models, whether each user's use of them is a capped
 *  allowance, and which providers the user has a key for. */
export type ModelMenu = { outrunner: boolean; allowance: boolean; keys: ProviderId[] };

/** The menu: Outrunner's models first, where the server has them; then each
 *  provider the user has a key for; the user's Claude, and Codex last, each
 *  only where `accounts` (connectedAccounts) has it. With `agent` (a running
 *  session's), only what that agent runs: in Codex, Outrunner's models and
 *  Codex's own. */
export function modelGroups(menu: ModelMenu, accounts: readonly AgentId[], agent?: AgentId): ModelGroup[] {
  const groups: ModelGroup[] = [];
  if (menu.outrunner) {
    groups.push({
      label: menu.allowance ? "Outrunner · included" : "Outrunner",
      provider: "outrunner",
      models: OUTRUNNER_MODELS,
      custom: false,
    });
  }
  for (const provider of PROVIDER_IDS) {
    if (!menu.keys.includes(provider)) continue;
    groups.push({
      label: `${PROVIDERS[provider].label} · your key`,
      provider,
      models: providerModels(provider),
      custom: true,
    });
  }
  if (accounts.includes("claude")) {
    groups.push({ label: "Claude account", provider: "claude", models: CLAUDE_MODELS, custom: false });
  }
  if (accounts.includes("codex")) {
    groups.push({ label: "Codex", provider: "codex", models: CODEX_MODELS, custom: true });
  }
  return agent ? groups.filter((group) => agentsFor(group.provider).includes(agent)) : groups;
}

/**
 * What a new session starts on when none is chosen and the user's Claude
 * isn't connected (where it is, the session starts on CLAUDE_DEFAULT_MODEL):
 * Outrunner's first model, on the user's own OpenRouter key when they saved
 * one, else on Outrunner's where the server has it, else the first model on
 * the first key they have. Null with none of those: the session needs the
 * user's Claude.
 */
export function defaultModel(menu: ModelMenu): SessionModel | null {
  const first = OUTRUNNER_MODELS[0];
  if (menu.keys.includes("openrouter")) return { ...first, provider: "openrouter" };
  if (menu.outrunner) return first;
  const provider = PROVIDER_IDS.find((id) => menu.keys.includes(id));
  return provider ? providerModels(provider)[0] : null;
}

/** How hard a model thinks, lowest first: the levels Claude Code's --effort
 *  and Codex's model_reasoning_effort both take (claude.Efforts). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The effort a model that takes one runs at when none is picked for it. */
export const DEFAULT_EFFORT: Effort = "high";

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

/** The Claude account's models that take an effort. Haiku isn't one: Claude
 *  Code sends no effort for a model without it, so a pick would do nothing. */
const CLAUDE_EFFORT_MODELS = new Set(["opus", "sonnet"]);

/**
 * Whether a model runs at an effort the user picks: Opus and Sonnet on the
 * user's Claude, and Codex's models. One through a gateway runs at its own:
 * Claude Code knows nothing of another provider's model's reasoning, so an
 * effort there would show a choice the model never gets.
 */
export function takesEffort(model: { provider: ModelProvider; id: string }): boolean {
  if (model.provider === "codex") return true;
  return model.provider === "claude" && CLAUDE_EFFORT_MODELS.has(model.id);
}

/** A request body's effort: undefined when it names none, null when it names
 *  one that isn't a level. */
export function requestedEffort(body: { effort?: unknown } | null): Effort | null | undefined {
  if (body?.effort === undefined || body.effort === null) return undefined;
  return isEffort(body.effort) ? body.effort : null;
}

/** A model id the agent takes (claude.ValidModel): up to 100 characters, no
 *  leading dash, nothing a shell or a flag could make more of. */
const MODEL_ID = /^(?!-)[A-Za-z0-9\-._:/[\]~]{1,100}$/;

export function validModelId(id: string): boolean {
  return MODEL_ID.test(id);
}

function isModelProvider(value: unknown): value is ModelProvider {
  return value === "outrunner" || value === "claude" || value === "codex" || isProviderId(value);
}

/**
 * A choice from a request, checked: Outrunner's must be one of its models (the
 * allowance pays for them), the user's Claude one of its aliases, and a model
 * on the user's own key, or Codex's, any id the agent takes. Null for
 * anything else.
 */
export function modelChoice(provider: unknown, model: unknown): SessionModel | null {
  if (!isModelProvider(provider) || typeof model !== "string") return null;
  if (provider === "outrunner") return OUTRUNNER_MODELS.find((m) => m.id === model) ?? null;
  if (provider === "claude") return CLAUDE_MODELS.find((m) => m.id === model) ?? null;
  if (!validModelId(model)) return null;
  const listed = provider === "codex" ? CODEX_MODELS : providerModels(provider);
  return listed.find((m) => m.id === model) ?? { id: model, label: model, provider };
}

/** The model a session was last put on, and the effort picked with it (none:
 *  the model's own), as its row records it (workspaces.model_*). */
export type RecordedModel = { model: SessionModel; effort: Effort | null };

/** A row's recorded model, checked as a request's choice is: null when none
 *  is recorded, or one this release no longer offers. */
export function recordedModel(provider: unknown, model: unknown, effort: unknown): RecordedModel | null {
  const choice = modelChoice(provider, model);
  return choice ? { model: choice, effort: isEffort(effort) ? effort : null } : null;
}

/**
 * A request body's choice: `{ provider, model }`; or, from a page loaded
 * before providers (kept for one release), `{ model, key }`, where `key` said
 * which OpenRouter key ran Outrunner's models. Undefined when the body names
 * no model; null when it names one that isn't offered.
 */
export function requestedModel(
  body: { provider?: unknown; model?: unknown; key?: unknown } | null,
): SessionModel | null | undefined {
  if (body?.model === undefined) return undefined;
  if (body.provider !== undefined) return modelChoice(body.provider, body.model);
  if (CLAUDE_MODELS.some((m) => m.id === body.model)) return modelChoice("claude", body.model);
  return modelChoice(body.key === "own" ? "openrouter" : "outrunner", body.model);
}

/** Trim Claude's model id to a stable label — drop a trailing -YYYYMMDD date so
 *  "claude-opus-4-5-20250115" reads as "claude-opus-4-5". */
export function modelLabel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Which offered model a reported one is: an exact id (a provider's name, or
 *  an alias), or the Claude family an id names ("claude-opus-5" is Opus).
 *  Undefined when it is none of them. */
export function matchModel(
  groups: ModelGroup[],
  reported: string | undefined,
  /** Whose entry, where a model is offered by two (a reply names only the
   *  model). */
  preferred?: ModelProvider,
): SessionModel | undefined {
  if (!reported) return undefined;
  const all = groups.flatMap((g) => g.models);
  const exact = all.filter((m) => m.id === reported);
  if (exact.length > 0) return exact.find((m) => m.provider === preferred) ?? exact[0];
  const family = reported.toLowerCase().match(/^claude-(opus|sonnet|haiku)\b/)?.[1];
  return family ? all.find((m) => m.provider === "claude" && m.id === family) : undefined;
}

/** The agent's POST /workspaces/:id/model body: with a gateway, the session
 *  runs through it on `token`; with an effort, at it. */
export type SetModelRequest = { model: string; gateway?: ProviderId; token?: string; effort?: Effort };

/** Who holds the key a model runs on: Outrunner, or one of the user's own. */
export type KeyHolder = Exclude<ModelProvider, "claude" | "codex">;

/**
 * The agent request that puts a session on `model`: Outrunner's through
 * OpenRouter on Outrunner's key, a provider's through that provider on the
 * user's key (both from `keyFor`), and the user's Claude, or Codex, on how
 * the session's agent signs in, with no key asked for. `effort` goes with a
 * model that takes one (takesEffort); any other runs at its own.
 */
export async function setModelRequest(
  model: SessionModel,
  keyFor: (holder: KeyHolder) => Promise<string>,
  effort?: Effort | null,
): Promise<SetModelRequest> {
  const at = effort && takesEffort(model) ? { effort } : {};
  if (model.provider === "claude" || model.provider === "codex") return { model: model.id, ...at };
  const gateway: ProviderId = model.provider === "outrunner" ? "openrouter" : model.provider;
  return { model: model.id, gateway, token: await keyFor(model.provider), ...at };
}

/** An agent from before efforts: it switched the model, but ran it at the
 *  model's own effort, not the one asked for. */
export class EffortUnsupportedError extends Error {
  constructor() {
    super("This session's Outrunner is too old to set the effort. Update Outrunner and try again.");
    this.name = "EffortUnsupportedError";
  }
}

/** Check the agent's answer to `req`: one that knows efforts says which it
 *  applied, and an older one says none. */
export function checkEffortApplied(req: SetModelRequest, answer: unknown): void {
  if (!req.effort) return;
  const applied = answer && typeof answer === "object" ? (answer as { effort?: unknown }).effort : undefined;
  if (applied !== req.effort) throw new EffortUnsupportedError();
}

/** An agent's refusal of a provider it doesn't know: one released before it,
 *  or, for a Codex session, one from before Codex ran through a gateway. */
export function predatesProvider(message: string | undefined): boolean {
  return /unknown gateway|runs on OpenAI's models directly and can't use a gateway/.test(message ?? "");
}

/** What to tell the user when the agent predates a provider. */
export function predatesProviderMessage(model: SessionModel): string {
  const name =
    model.provider === "outrunner" || model.provider === "claude" || model.provider === "codex"
      ? model.label
      : PROVIDERS[model.provider].label;
  return `This session's Outrunner is too old to run ${name} models. Update Outrunner and try again.`;
}
