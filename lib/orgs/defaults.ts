/**
 * How an org's defaults meet a member's own (lib/db/org-defaults.ts): the
 * member's choice wins; the org's is for one they haven't made; Outrunner's
 * own after that. Pure, for the browser and the tests.
 */

import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import { LOADOUT_MAX, type LoadoutEntry, type ModelLoadout, sameEntry } from "@/lib/runtime/model-loadout";

/** The size of a member's new box: theirs once they chose it, else their
 *  org's, else the one every user starts with. */
export function newBoxSize(own: { boxSize: BoxSizeId; boxSizeChosen: boolean }, org: BoxSizeId | null): BoxSizeId {
  return own.boxSizeChosen || !org ? own.boxSize : org;
}

/** A member's loadout with the org's default model where they set none: it
 *  joins the models the picker shows first, at the end, in place of their
 *  last where they keep as many as a loadout holds. */
export function withOrgDefault(loadout: ModelLoadout, org: LoadoutEntry | null): ModelLoadout {
  if (loadout.default || !org) return loadout;
  const kept = loadout.models.find((e) => sameEntry(e, org));
  if (kept) return { models: loadout.models, default: kept };
  return { models: [...loadout.models.slice(0, LOADOUT_MAX - 1), org], default: org };
}

/** An org's defaults on a session's way: none rather than no session when
 *  they can't be read. */
export async function orgDefaultsOrNone<T>(read: () => Promise<T>, none: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error("Couldn't read the org's defaults; going on without them", error);
    return none;
  }
}
