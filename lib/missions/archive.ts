/**
 * Archiving a Runner with its Ships (docs/missions.md), the parts with no
 * network: when it's offered, what the server does in what order, and the
 * browser's ask for it. The wiring is lib/missions/archive.deps.ts; the route
 * is POST /api/missions/[id]/archive.
 */

import { isLiveRunner } from "@/lib/missions/rules";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import type { ArchiveOffer } from "@/lib/session/archive-control";

/** Ships archived at once: each saves its worktree, which can take a minute. */
export const ARCHIVE_CONCURRENCY = 4;

/**
 * Archive for a Runner in `status`: pressable while its box is up or asleep
 * (one asleep is woken to save its work), shown disabled saying why while
 * it's between those, and not offered once archived, deleted or failed.
 */
export function missionArchiveOffer(status: WorkspaceStatus): ArchiveOffer | null {
  switch (status) {
    case "ready":
    case "idle":
    case "suspended":
      return { can: true };
    case "creating":
    case "provisioning":
      return { can: false, why: "It can be archived once its setup finishes." };
    case "archiving":
      return { can: false, why: "It's being archived." };
    case "restoring":
      return { can: false, why: "It can be archived once it's restored." };
    case "suspending":
    case "resuming":
      return { can: false, why: "It can be archived in a moment, once its box settles." };
    case "archived":
    case "destroying":
    case "destroyed":
    case "failed":
      return null;
  }
  const unknown: never = status;
  void unknown;
  return null;
}

/** What the confirmation says will happen, for a Runner with `ships` Ships
 *  that aren't archived. */
export function missionArchiveConsequence(ships: number): string {
  const them =
    ships === 0
      ? ""
      : `${ships === 1 ? "Its Ship is" : `Its ${ships} Ships are`} archived with it, even one at work or with a pull request open (that stays open on GitHub). `;
  return (
    them +
    "Their work is saved and their boxes freed, and news from them no longer reaches it. " +
    "Opening the Runner restores it; a Ship comes back when it's opened or messaged."
  );
}

export type MissionArchiveDeps = {
  runners(missionId: string): Promise<Workspace[]>;
  /** Forget the messages queued for its Ships: sent once a turn ends, they
   *  would restore a Ship just archived. */
  dropQueued(missionId: string): Promise<void>;
  /** Archive one session as its owner, waking it first if asleep; why not,
   *  or null once archived. */
  archive(session: Workspace): Promise<string | null>;
};

/** A Ship left as it was, and why. */
export type ShipLeft = { id: string; name: string; why: string };

export type MissionArchiveResult = { archived: true; ships: number } | { archived: false; ships: number; left: ShipLeft[]; why: string };

/** Why a Ship in `status` can't be archived now, or null when it can. */
function shipNotNow(status: WorkspaceStatus): string | null {
  if (status === "ready" || status === "idle" || status === "suspended") return null;
  if (status === "creating" || status === "provisioning") return "it's still setting up";
  if (status === "restoring") return "it's being restored";
  return "its box is starting or stopping";
}

/**
 * Archive `mission`'s Ships, then the Runner itself: the Runner goes only
 * once every Ship has, so none is left at work with no one to hear it. One
 * that can't be archived now leaves the Runner as it is, saying which; those
 * archived stay archived, and asking again archives the rest.
 */
export async function archiveMission(mission: Workspace, deps: MissionArchiveDeps): Promise<MissionArchiveResult> {
  await deps.dropQueued(mission.id);
  const live = (await deps.runners(mission.id)).filter((r) => isLiveRunner(r) && r.status !== "archiving");
  const left: ShipLeft[] = [];
  let ships = 0;
  const queue = [...live];
  const worker = async () => {
    for (let ship = queue.shift(); ship; ship = queue.shift()) {
      const why = shipNotNow(ship.status) ?? (await deps.archive(ship).catch((e: unknown) => (e instanceof Error ? e.message : String(e))));
      if (why === null) ships++;
      else left.push({ id: ship.id, name: ship.title ?? ship.branch, why });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, live.length) }, worker));
  if (left.length > 0) {
    const named = left.map((s) => `“${s.name}” (${s.why})`).join(", ");
    return {
      archived: false,
      ships,
      left,
      why: `The Runner wasn't archived: ${left.length === 1 ? "a Ship" : `${left.length} Ships`} couldn't be yet: ${named}. Try again shortly.`,
    };
  }
  if (mission.status !== "archived") {
    const why = missionArchiveOffer(mission.status)?.can ? await deps.archive(mission).catch(() => "it didn't answer") : "it isn't running";
    if (why !== null) return { archived: false, ships, left, why: `Its Ships are archived, but the Runner itself couldn't be: ${why}.` };
  }
  return { archived: true, ships };
}

/**
 * Archive the Runner `id` with its Ships, from the browser. Throws with a
 * sentence to show when it (or one of its Ships) couldn't be.
 */
export async function requestMissionArchive(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/missions/${id}/archive`, { method: "POST" });
  } catch {
    throw new Error("Could not reach Outrunner. Check your connection and try again.");
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw new Error(typeof body.error === "string" ? body.error : "Could not archive this Runner. Please try again.");
}
