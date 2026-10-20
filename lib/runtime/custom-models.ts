/**
 * Model ids the user typed in for a provider on their own key, or for Codex,
 * remembered in this browser so the menu offers them again. A convenience
 * only: any valid id can be typed again, and the server checks each choice
 * itself.
 */

import { isProviderId, PROVIDERS, type ProviderId } from "@/lib/providers/registry";
import {
  CODEX_MODELS,
  type ModelProvider,
  providerModels,
  validModelId,
  type SessionModel,
} from "@/lib/runtime/session-models";

/** Whose groups take a model id typed in: a provider on the user's key, and
 *  Codex. */
export type TypedModelProvider = ProviderId | "codex";

export function takesTypedModels(provider: ModelProvider): provider is TypedModelProvider {
  return provider === "codex" || isProviderId(provider);
}

/** What the dialog calls them, and whose names their ids are. */
export function typedModelOwner(provider: TypedModelProvider): { label: string; namedBy: string; placeholder?: string } {
  if (provider === "codex") return { label: "Codex", namedBy: "OpenAI", placeholder: CODEX_MODELS[0]?.id };
  const { label, models } = PROVIDERS[provider];
  return { label, namedBy: label, placeholder: models[0]?.id };
}

function listedModels(provider: TypedModelProvider): SessionModel[] {
  return provider === "codex" ? CODEX_MODELS : providerModels(provider);
}

/** How many a provider's group remembers, newest first. */
const KEEP = 5;

const storageKey = (provider: TypedModelProvider) => `outrunner:custom-models:${provider}`;

export function rememberedCustomModels(provider: TypedModelProvider): SessionModel[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey(provider)) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((id): id is string => typeof id === "string" && validModelId(id))
      .slice(0, KEEP)
      .map((id) => ({ id, label: id, provider }));
  } catch {
    return [];
  }
}

/** Remember `id` for `provider`, unless it's one the menu lists anyway. */
export function rememberCustomModel(provider: TypedModelProvider, id: string): void {
  if (!validModelId(id) || listedModels(provider).some((m) => m.id === id)) return;
  const ids = [id, ...rememberedCustomModels(provider).map((m) => m.id).filter((other) => other !== id)];
  try {
    window.localStorage.setItem(storageKey(provider), JSON.stringify(ids.slice(0, KEEP)));
  } catch {
    // Blocked storage: the id just isn't offered again.
  }
}
