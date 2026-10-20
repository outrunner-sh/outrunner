/**
 * The user's model loadout (Settings → Default models): the models the chat
 * picker shows first, in their order, and the one a new session starts on.
 * Each is a choice from the menu (lib/runtime/session-models.ts), named by
 * its provider and id; one the menu doesn't offer right now (its key
 * removed) is kept, but not shown, until it is again.
 *
 * Imports only the menu, so the browser and the tests use it as is.
 */

import { modelChoice, type ModelGroup, type ModelProvider, type SessionModel } from "@/lib/runtime/session-models";

/** One model in the loadout: whose, and which. */
export type LoadoutEntry = { provider: ModelProvider; id: string };

export type ModelLoadout = {
  /** In the order the picker shows them. */
  models: LoadoutEntry[];
  /** The one a new session starts on; one of `models`, or none. */
  default: LoadoutEntry | null;
};

export const EMPTY_LOADOUT: ModelLoadout = { models: [], default: null };

/** As many as the picker shows without scrolling past use. */
export const LOADOUT_MAX = 12;

export function sameEntry(a: LoadoutEntry | null | undefined, b: LoadoutEntry | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/** An entry from anywhere (a request, a stored row), checked as a menu
 *  choice is; null for anything else. */
function parseEntry(raw: unknown): LoadoutEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { provider, id } = raw as { provider?: unknown; id?: unknown };
  const model = modelChoice(provider, id);
  return model ? { provider: model.provider, id: model.id } : null;
}

/**
 * A loadout from anywhere, made sound: entries that aren't menu choices
 * dropped, each kept once, at most {@link LOADOUT_MAX}, and a default that is
 * one of them (else none).
 */
export function parseLoadout(raw: unknown): ModelLoadout {
  if (!raw || typeof raw !== "object") return EMPTY_LOADOUT;
  const { models, default: chosen } = raw as { models?: unknown; default?: unknown };
  const entries: LoadoutEntry[] = [];
  for (const item of Array.isArray(models) ? models : []) {
    const entry = parseEntry(item);
    if (entry && !entries.some((e) => sameEntry(e, entry)) && entries.length < LOADOUT_MAX) entries.push(entry);
  }
  const fallback = parseEntry(chosen);
  return { models: entries, default: entries.find((e) => sameEntry(e, fallback)) ?? null };
}

/** The menu's model an entry names, where the menu offers it now. */
export function offeredModel(groups: ModelGroup[], entry: LoadoutEntry): SessionModel | undefined {
  const group = groups.find((g) => g.provider === entry.provider);
  if (!group) return undefined;
  return group.models.find((m) => m.id === entry.id) ?? (group.custom ? { ...entry, label: entry.id } : undefined);
}

/** The loadout's models the menu offers now, in its order. */
export function loadoutModels(loadout: ModelLoadout, groups: ModelGroup[]): SessionModel[] {
  return loadout.models.flatMap((entry) => offeredModel(groups, entry) ?? []);
}

/** The model a new session starts on by the loadout: its default, where the
 *  menu offers it now. */
export function loadoutDefault(loadout: ModelLoadout, groups: ModelGroup[]): SessionModel | undefined {
  return loadout.default ? offeredModel(groups, loadout.default) : undefined;
}

/** `entry` added at the end, or taken out; the default goes with it. */
export function toggleEntry(loadout: ModelLoadout, entry: LoadoutEntry): ModelLoadout {
  if (loadout.models.some((e) => sameEntry(e, entry))) {
    const models = loadout.models.filter((e) => !sameEntry(e, entry));
    return { models, default: sameEntry(loadout.default, entry) ? null : loadout.default };
  }
  if (loadout.models.length >= LOADOUT_MAX) return loadout;
  // The first model picked is the default until another is made it.
  return { models: [...loadout.models, entry], default: loadout.default ?? entry };
}

/** `entry` moved one place toward the start (`-1`) or the end (`1`). */
export function moveEntry(loadout: ModelLoadout, entry: LoadoutEntry, step: -1 | 1): ModelLoadout {
  const from = loadout.models.findIndex((e) => sameEntry(e, entry));
  const to = from + step;
  if (from < 0 || to < 0 || to >= loadout.models.length) return loadout;
  const models = [...loadout.models];
  [models[from], models[to]] = [models[to], models[from]];
  return { ...loadout, models };
}

/** Models whose name or id has `query` in it, case aside. */
export function searchModels(models: SessionModel[], query: string): SessionModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}
