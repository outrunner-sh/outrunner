/**
 * How an org's defaults meet a member's own (lib/db/org-defaults.ts): the
 * member's choice wins; the org's is for one they haven't made; Outrunner's
 * own after that. Pure, for the browser and the tests.
 */

import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import { type LoadoutEntry, type ModelLoadout, sameEntry } from "@/lib/runtime/model-loadout";

/** The size of a member's new box: theirs once they chose it, else their
 *  org's, else the one every user starts with. */
export function newBoxSize(own: { boxSize: BoxSizeId; boxSizeChosen: boolean }, org: BoxSizeId | null): BoxSizeId {
  return own.boxSizeChosen || !org ? own.boxSize : org;
}

/** A member's loadout with the org's default model where they set none: it
 *  joins the models the picker shows first, at the end. */
export function withOrgDefault(loadout: ModelLoadout, org: LoadoutEntry | null): ModelLoadout {
  if (loadout.default || !org) return loadout;
  const kept = loadout.models.find((e) => sameEntry(e, org));
  return { models: kept ? loadout.models : [...loadout.models, org], default: kept ?? org };
}
