/**
 * The models a session can be switched to. No imports, so it unit-tests
 * without React or a session.
 */

/** Who serves a model: the user's own Claude; Neev AI through OpenRouter, on
 *  Outrunner's key; or the same through OpenRouter on the user's own key. */
export type ModelSource = "claude" | "neev" | "own";

/** `id` is what the session runs: a Claude alias, or an OpenRouter slug. */
export type SessionModel = { id: string; label: string; source: ModelSource };

export type ModelGroup = { label: string; models: SessionModel[] };

/** Neev AI: served through OpenRouter on the user's own capped key. Exact
 *  OpenRouter slugs, so the menu ticks what a reply reports. */
export const NEEV_AI_MODELS: SessionModel[] = [
  { id: "z-ai/glm-5.3", label: "GLM 5.3", source: "neev" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet", source: "neev" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus", source: "neev" },
];

/** Outrunner's models again, on the user's own OpenRouter key (Settings →
 *  Providers): the same slugs, a different key paying. */
export const OWN_OPENROUTER_MODELS: SessionModel[] = NEEV_AI_MODELS.map((m) => ({ ...m, source: "own" }));

/** The user's own Claude. Aliases, so each is the newest of its family without
 *  a release here. */
export const CLAUDE_MODELS: SessionModel[] = [
  { id: "opus", label: "Opus", source: "claude" },
  { id: "sonnet", label: "Sonnet", source: "claude" },
  { id: "haiku", label: "Haiku", source: "claude" },
];

/** The menu: Outrunner's own models first, offered by default (shown under the
 *  product's name; "Neev AI" is the code's name for them), the user's Claude
 *  after. */
export const MODEL_GROUPS: ModelGroup[] = modelGroups({ ownKey: false, serverModels: true, allowance: false });

/** What a user's menu offers (GET /api/neev-ai): whether they saved their own
 *  OpenRouter key, whether the server has one, and whether the server's is
 *  each user's capped allowance. */
export type OpenRouterKeys = { ownKey: boolean; serverModels: boolean; allowance: boolean };

/** The menu for a user. With their own OpenRouter key, Outrunner's models
 *  come twice: on Outrunner's key (where the server has one) and on theirs,
 *  so they pick which pays. */
export function modelGroups(keys: OpenRouterKeys): ModelGroup[] {
  const groups: ModelGroup[] = [];
  if (keys.serverModels || !keys.ownKey) {
    groups.push({ label: keys.allowance ? "Outrunner · included" : "Outrunner", models: NEEV_AI_MODELS });
  }
  if (keys.ownKey) groups.push({ label: "OpenRouter · your key", models: OWN_OPENROUTER_MODELS });
  groups.push({ label: "Claude account", models: CLAUDE_MODELS });
  return groups;
}

/** What a new cloud session starts on: Outrunner's own model, so anyone can
 *  start one without a Claude account. A local session starts on it too when
 *  the Mac's Claude Code isn't logged in. */
export const DEFAULT_CLOUD_MODEL: SessionModel = NEEV_AI_MODELS[0];

/** Trim Claude's model id to a stable label — drop a trailing -YYYYMMDD date so
 *  "claude-opus-4-5-20250115" reads as "claude-opus-4-5". */
export function modelLabel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Which offered model a reported one is: an exact id (an OpenRouter slug, or
 *  an alias), or the Claude family an id names ("claude-opus-5" is Opus).
 *  Undefined when it is none of them. */
export function matchModel(
  groups: ModelGroup[],
  reported: string | undefined,
  /** Which key's entry, where a model is offered on two (a reply names only
   *  the model). */
  preferred?: ModelSource,
): SessionModel | undefined {
  if (!reported) return undefined;
  const all = groups.flatMap((g) => g.models);
  const exact = all.filter((m) => m.id === reported);
  if (exact.length > 0) return exact.find((m) => m.source === preferred) ?? exact[0];
  const family = reported.toLowerCase().match(/^claude-(opus|sonnet|haiku)\b/)?.[1];
  return family ? all.find((m) => m.source === "claude" && m.id === family) : undefined;
}

/** The menu's model with exactly this id, if there is one. */
export function offeredModel(modelId: unknown): SessionModel | undefined {
  return MODEL_GROUPS.flatMap((g) => g.models).find((m) => m.id === modelId);
}

/** The agent's POST /workspaces/:id/model body. */
export type SetModelRequest = { model: string; gateway?: "openrouter"; token?: string };

/** The agent request that switches a session to one of the menu's models: a
 *  Neev AI model runs through OpenRouter on the key `neevKey` gets, a Claude
 *  account model on the session's own Claude login. Null for any other id. */
export async function setModelRequest(
  modelId: unknown,
  neevKey: () => Promise<string>,
): Promise<SetModelRequest | null> {
  const model = offeredModel(modelId);
  if (!model) return null;
  if (model.source === "claude") return { model: model.id };
  return { model: model.id, gateway: "openrouter", token: await neevKey() };
}
