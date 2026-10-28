/**
 * The user's model loadout (Settings → Default models): the models the chat
 * picker shows first, in their order, and the one a new session starts on.
 * Each is a choice from the menu (lib/runtime/session-models.ts), named by
 * its provider and id; one the menu doesn't offer right now (its key
 * removed) is kept, but not shown, until it is again.
 *
 * Imports only the menu, so the browser and the tests use it as is.
 */

import { AGENTS, type AgentId } from "@/lib/agents/registry";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_EFFORT,
  type Effort,
  isEffort,
  modelChoice,
  type ModelGroup,
  type ModelProvider,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";

/** One model in the loadout: whose, which, and the effort it runs at when
 *  picked (none: the model's own; only on a model that takes one). */
export type LoadoutEntry = { provider: ModelProvider; id: string; effort?: Effort };

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
export function parseLoadoutEntry(raw: unknown): LoadoutEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { provider, id, effort } = raw as { provider?: unknown; id?: unknown; effort?: unknown };
  const model = modelChoice(provider, id);
  if (!model) return null;
  const entry: LoadoutEntry = { provider: model.provider, id: model.id };
  // An effort the model doesn't take is dropped, not kept to mislead.
  if (isEffort(effort) && takesEffort(model)) entry.effort = effort;
  return entry;
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
    const entry = parseLoadoutEntry(item);
    if (entry && !entries.some((e) => sameEntry(e, entry)) && entries.length < LOADOUT_MAX) entries.push(entry);
  }
  const fallback = parseLoadoutEntry(chosen);
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

/** The effort the loadout runs `model` at; undefined when it isn't in the
 *  loadout, or runs at its own. */
export function loadoutEffort(loadout: ModelLoadout, model: LoadoutEntry): Effort | undefined {
  return loadout.models.find((e) => sameEntry(e, model))?.effort;
}

/** The effort `model` runs at when picked: the loadout's for it (null: the
 *  model's own, as Settings shows it), else DEFAULT_EFFORT. Only a model that
 *  takes one gets it (takesEffort). */
export function effortOnPick(loadout: ModelLoadout | undefined, model: LoadoutEntry): Effort | null {
  const entry = loadout?.models.find((e) => sameEntry(e, model));
  return entry ? (entry.effort ?? null) : DEFAULT_EFFORT;
}

/** `entry` set to run at `effort`, or at its own with null. A model not in
 *  the loadout, or one that takes no effort, is left as it is. */
export function setEntryEffort(loadout: ModelLoadout, entry: LoadoutEntry, effort: Effort | null): ModelLoadout {
  if (!takesEffort(entry) || !loadout.models.some((e) => sameEntry(e, entry))) return loadout;
  const models = loadout.models.map((e): LoadoutEntry => {
    if (!sameEntry(e, entry)) return e;
    const bare = { provider: e.provider, id: e.id };
    return effort ? { ...bare, effort } : bare;
  });
  return { ...loadout, models };
}

/** `entry` added at the end, at DEFAULT_EFFORT where it takes one, or taken
 *  out; the default goes with it. */
export function toggleEntry(loadout: ModelLoadout, entry: LoadoutEntry): ModelLoadout {
  if (loadout.models.some((e) => sameEntry(e, entry))) {
    const models = loadout.models.filter((e) => !sameEntry(e, entry));
    return { models, default: sameEntry(loadout.default, entry) ? null : loadout.default };
  }
  if (loadout.models.length >= LOADOUT_MAX) return loadout;
  const added: LoadoutEntry = { provider: entry.provider, id: entry.id };
  if (takesEffort(entry)) added.effort = DEFAULT_EFFORT;
  // The first model picked is the default until another is made it.
  return { models: [...loadout.models, added], default: loadout.default ?? added };
}

/**
 * `entry` moved past its neighbour toward the start (`-1`) or the end (`1`):
 * the nearest one `visible` (those the picker shows now) where given, so one
 * not offered now (its key removed) never takes a move.
 */
export function moveEntry(
  loadout: ModelLoadout,
  entry: LoadoutEntry,
  step: -1 | 1,
  visible?: LoadoutEntry[],
): ModelLoadout {
  const from = loadout.models.findIndex((e) => sameEntry(e, entry));
  if (from < 0) return loadout;
  let to = from + step;
  while (to >= 0 && to < loadout.models.length && visible && !visible.some((v) => sameEntry(v, loadout.models[to]))) {
    to += step;
  }
  if (to < 0 || to >= loadout.models.length) return loadout;
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

/** Each agent's own models, offered once it's connected. */
const AGENT_MODELS: Record<AgentId, SessionModel[]> = { claude: CLAUDE_MODELS, codex: CODEX_MODELS };

/**
 * The agents to connect (`connect`, not connected here) the picker offers
 * while `query` is searched, `matched` being how many models it found: those
 * whose name or own models the search is for, and every one when it found
 * nothing, so a search never ends at "No model matches" alone.
 */
export function connectOffers(connect: AgentId[], query: string, matched: number): AgentId[] {
  const q = query.trim().toLowerCase();
  if (!q || matched === 0) return connect;
  return connect.filter(
    (agent) => AGENTS[agent].label.toLowerCase().includes(q) || searchModels(AGENT_MODELS[agent], q).length > 0,
  );
}
