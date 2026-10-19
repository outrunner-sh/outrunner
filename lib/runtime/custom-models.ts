/**
 * Model ids the user typed in for a provider on their own key, remembered in
 * this browser so the menu offers them again. A convenience only: any valid
 * id can be typed again, and the server checks each choice itself.
 */

import type { ProviderId } from "@/lib/providers/registry";
import { providerModels, validModelId, type SessionModel } from "@/lib/runtime/session-models";

/** How many a provider's group remembers, newest first. */
const KEEP = 5;

const storageKey = (provider: ProviderId) => `outrunner:custom-models:${provider}`;

export function rememberedCustomModels(provider: ProviderId): SessionModel[] {
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
export function rememberCustomModel(provider: ProviderId, id: string): void {
  if (!validModelId(id) || providerModels(provider).some((m) => m.id === id)) return;
  const ids = [id, ...rememberedCustomModels(provider).map((m) => m.id).filter((other) => other !== id)];
  try {
    window.localStorage.setItem(storageKey(provider), JSON.stringify(ids.slice(0, KEEP)));
  } catch {
    // Blocked storage: the id just isn't offered again.
  }
}
