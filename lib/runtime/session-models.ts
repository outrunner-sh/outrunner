/**
 * The models a session can run, and who serves each: Outrunner (its models,
 * on Outrunner's key and the user's allowance), the user's own Claude, a
 * provider on a key of the user's own (Settings → Providers), or Codex. A
 * choice is always both, a provider and a model, from the menu to the agent,
 * and the provider says which agent runs it: Codex runs Codex's models, and
 * Claude Code every other. Imports only the registries, so it unit-tests
 * without React or a session.
 */

import type { AgentId } from "@/lib/agents/registry";
import { isProviderId, PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** Who serves a model. */
export type ModelProvider = "outrunner" | "claude" | "codex" | ProviderId;

/** `id` is the provider's name for the model: a Claude alias, an OpenRouter
 *  slug, or a provider's own. */
export type SessionModel = { id: string; label: string; provider: ModelProvider };

/** `custom`: the group takes a model id typed in, as well as its list. */
export type ModelGroup = { label: string; provider: ModelProvider; models: SessionModel[]; custom: boolean };

/** Outrunner's models, through OpenRouter on Outrunner's key. Exact OpenRouter
 *  slugs, so the menu ticks what a reply reports. Only these run on it: the
 *  allowance pays for them. */
export const OUTRUNNER_MODELS: SessionModel[] = [
  { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet", provider: "outrunner" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus", provider: "outrunner" },
];

/** The user's own Claude. Aliases, so each is the newest of its family without
 *  a release here. */
export const CLAUDE_MODELS: SessionModel[] = [
  { id: "opus", label: "Opus", provider: "claude" },
  { id: "sonnet", label: "Sonnet", provider: "claude" },
  { id: "haiku", label: "Haiku", provider: "claude" },
];

/** Codex's models, on however the user signs Codex in (Settings → Providers →
 *  Codex): OpenAI's names, as on its API. */
export const CODEX_MODELS: SessionModel[] = PROVIDERS.openai.models.map((m) => ({ ...m, provider: "codex" }));

/** The agent that runs a provider's models. A session keeps its agent: its
 *  model can change only to another the same agent runs. */
export function agentOf(provider: ModelProvider): AgentId {
  return provider === "codex" ? "codex" : "claude";
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
 *  provider the user has a key for; the user's Claude; Codex last. With
 *  `agent` (a running session's), only what that agent runs. */
export function modelGroups(menu: ModelMenu, agent?: AgentId): ModelGroup[] {
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
  groups.push({ label: "Claude account", provider: "claude", models: CLAUDE_MODELS, custom: false });
  groups.push({ label: "Codex", provider: "codex", models: CODEX_MODELS, custom: true });
  return agent ? groups.filter((group) => agentOf(group.provider) === agent) : groups;
}

/**
 * What a new session starts on when none is chosen: Outrunner's first model,
 * on the user's own OpenRouter key when they saved one, else on Outrunner's
 * where the server has it, else the first model on the first key they have.
 * Null with none of those: the session starts on the user's Claude.
 */
export function defaultModel(menu: ModelMenu): SessionModel | null {
  const first = OUTRUNNER_MODELS[0];
  if (menu.keys.includes("openrouter")) return { ...first, provider: "openrouter" };
  if (menu.outrunner) return first;
  const provider = PROVIDER_IDS.find((id) => menu.keys.includes(id));
  return provider ? providerModels(provider)[0] : null;
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
 *  runs through it on `token`. */
export type SetModelRequest = { model: string; gateway?: ProviderId; token?: string };

/** Who holds the key a model runs on: Outrunner, or one of the user's own. */
export type KeyHolder = Exclude<ModelProvider, "claude" | "codex">;

/**
 * The agent request that puts a session on `model`: Outrunner's through
 * OpenRouter on Outrunner's key, a provider's through that provider on the
 * user's key (both from `keyFor`), and the user's Claude, or Codex, on how
 * the session's agent signs in, with no key asked for.
 */
export async function setModelRequest(
  model: SessionModel,
  keyFor: (holder: KeyHolder) => Promise<string>,
): Promise<SetModelRequest> {
  if (model.provider === "claude" || model.provider === "codex") return { model: model.id };
  const gateway: ProviderId = model.provider === "outrunner" ? "openrouter" : model.provider;
  return { model: model.id, gateway, token: await keyFor(model.provider) };
}

/** An agent's refusal of a provider it doesn't know: one released before it. */
export function predatesProvider(message: string | undefined): boolean {
  return /unknown gateway/.test(message ?? "");
}

/** What to tell the user when the agent predates a provider. */
export function predatesProviderMessage(model: SessionModel): string {
  const name =
    model.provider === "outrunner" || model.provider === "claude" || model.provider === "codex"
      ? model.label
      : PROVIDERS[model.provider].label;
  return `This session's Outrunner is too old to run ${name} models. Update Outrunner and try again.`;
}
