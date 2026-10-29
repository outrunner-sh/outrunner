/**
 * Archiving a Runner with its Ships (docs/missions.md), the parts with no
 * network: when it's offered, what the server does in what order, and the
 * browser's ask for it. The wiring is lib/missions/archive.deps.ts; the route
 * is POST /api/missions/[id]/archive.
 */

import { isLiveRunner } from "@/lib/missions/rules";
import { onRuntimeComputer, type Workspace } from "@/lib/runtime/types";
import type { ArchiveOffer } from "@/lib/session/archive-control";

/** Ships archived at once: each saves its worktree, which can take a minute. */
export const ARCHIVE_CONCURRENCY = 4;

/**
 * Archive for a Runner: offered only on a Runtime Computer, the one kind with
 * a Snapshot to restore from (as a session's is). Pressable while its box is
 * up or asleep (one asleep is woken to save its work), shown disabled saying
 * why while it's between those, and not offered once archived, deleted or
 * failed.
 */
export function missionArchiveOffer(runner: Pick<Workspace, "status" | "provider">): ArchiveOffer | null {
  if (!onRuntimeComputer(runner.provider)) return null;
  const { status } = runner;
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
  /** A session as it is now: an archive waits its turn, minutes perhaps. */
  session(id: string): Promise<Workspace | null>;
  /** Take the messages queued for a Ship, so a turn ending as it's archived
   *  can't send one (and restore it); their ids, to give back if it isn't. */
  takeQueued(runnerId: string): Promise<string[]>;
  returnQueued(ids: string[]): Promise<void>;
  /** Archive one session as its owner; why not, or null once archived, or
   *  `note` once archived without its files (its box out of reach). */
  archive(session: Workspace): Promise<string | ArchivedWithNote | null>;
  now(): number;
};

/** Archived, but without its files: what to tell the user. */
export type ArchivedWithNote = { note: string };

/** A Ship left as it was, and why. */
export type ShipLeft = { id: string; name: string; why: string };

/** A Ship archived without its files, its box out of reach. */
export type ShipUnsaved = { id: string; name: string };

export type MissionArchiveResult =
  /** `unsaved`, when there are any: Ships archived without their files. */
  | { archived: true; ships: number; unsaved?: ShipUnsaved[]; note?: string }
  /** `more`: only time ran out, so asking again goes on (the browser does). */
  | { archived: false; ships: number; left: ShipLeft[]; why: string; more: boolean; unsaved?: ShipUnsaved[] };

/** What's said of Ships archived without their files. */
export function unsavedNote(unsaved: ShipUnsaved[]): string {
  const named = unsaved.map((s) => `“${s.name}”`).join(", ");
  const one = unsaved.length === 1;
  return (
    `${one ? "A Ship was" : `${unsaved.length} Ships were`} archived without ${one ? "its" : "their"} files, ` +
    `${one ? "its box" : "their boxes"} out of reach: ${named}. ` +
    `Uncommitted changes on ${one ? "it" : "them"} couldn't be saved; anything pushed to GitHub is kept.`
  );
}

/** No Ship is started on after this long in one ask, so the last ones (a
 *  wake and a save, about 75 seconds each) and then the Runner's own end
 *  inside the route's 300. */
export const ARCHIVE_BUDGET_MS = 120_000;

/** Said of a Ship this ask didn't reach: the next one does. */
const NOT_REACHED = "not reached yet";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why a Ship as it is can't be archived now, or null when it can. */
function shipNotNow(ship: Pick<Workspace, "status" | "provider">): string | null {
  if (!onRuntimeComputer(ship.provider)) return "its computer can't archive";
  const { status } = ship;
  if (status === "ready" || status === "idle" || status === "suspended") return null;
  if (status === "creating" || status === "provisioning") return "it's still setting up";
  if (status === "restoring") return "it's being restored";
  // Another ask's, or one cut off: it counts as gone only once it is.
  if (status === "archiving") return "it's being archived";
  return "its box is starting or stopping";
}

const shipName = (ship: Workspace) => ship.title ?? ship.branch;
/** Ships not yet archived (or ended): one being archived still counts, as
 *  its archive may fail and leave it up. */
const toArchive = (ships: Workspace[]) => ships.filter(isLiveRunner);

/**
 * Archive `mission`'s Ships, then the Runner itself: the Runner goes only
 * once every Ship has, so none is left at work with no one to hear it.
 *
 * Nothing is touched while any Ship can't be archived now (one setting up,
 * say): the answer names them. Each Ship's queued messages are taken as it's
 * archived and given back if it isn't. Ships are read again before the
 * Runner goes, so one it started meanwhile keeps it; and each row is read
 * as its turn comes, as minutes may have passed. An ask that runs out of
 * time leaves the rest for the next (`more`); those archived stay archived.
 */
export async function archiveMission(mission: Workspace, deps: MissionArchiveDeps): Promise<MissionArchiveResult> {
  const started = deps.now();
  const unsaved: ShipUnsaved[] = [];
  const refuse = (ships: number, left: ShipLeft[]): MissionArchiveResult => {
    const refused = left.filter((s) => s.why !== NOT_REACHED);
    const toGo = left.length - refused.length;
    const more = refused.length === 0;
    const plural = (n: number) => `${n} Ship${n === 1 ? "" : "s"}`;
    const named = refused.map((s) => `“${s.name}” (${s.why})`).join(", ");
    const why = more
      ? `${plural(toGo)} still to archive. Try again to finish.`
      : `The Runner wasn't archived: ${refused.length === 1 ? "a Ship" : plural(refused.length)} couldn't be yet: ${named}` +
        `${toGo > 0 ? `, and ${plural(toGo)} still to archive` : ""}. Try again shortly.` +
        (unsaved.length > 0 ? ` ${unsavedNote(unsaved)}` : "");
    return { archived: false, ships, left, why, more, ...(unsaved.length > 0 && { unsaved }) };
  };

  const live = toArchive(await deps.runners(mission.id));
  const blocked = live.flatMap((ship) => {
    const why = shipNotNow(ship);
    return why ? [{ id: ship.id, name: shipName(ship), why }] : [];
  });
  if (blocked.length > 0) return refuse(0, blocked);

  const left: ShipLeft[] = [];
  let ships = 0;
  const queue = [...live];
  const archiveShip = async (listed: Workspace): Promise<string | null> => {
    const ship = await deps.session(listed.id);
    if (!ship || !toArchive([ship]).length) return null;
    const notNow = shipNotNow(ship);
    if (notNow) return notNow;
    const taken = await deps.takeQueued(ship.id);
    const answer = await deps.archive(ship).catch(errorText);
    if (answer !== null && typeof answer === "object") {
      unsaved.push({ id: ship.id, name: shipName(ship) });
      return null;
    }
    const why = answer;
    if (why !== null && taken.length > 0) {
      // The archive's reason is what's said; messages that couldn't be given
      // back are lost, and logged.
      await deps.returnQueued(taken).catch((e: unknown) => console.error(`Ship ${ship.id}: its queued messages couldn't be given back`, e));
    }
    return why;
  };
  const worker = async () => {
    for (let ship = queue.shift(); ship; ship = queue.shift()) {
      if (deps.now() - started > ARCHIVE_BUDGET_MS) {
        left.push({ id: ship.id, name: shipName(ship), why: NOT_REACHED });
        continue;
      }
      const why = await archiveShip(ship).catch(errorText);
      if (why === null) ships++;
      else left.push({ id: ship.id, name: shipName(ship), why });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, live.length) }, worker));
  // One the Runner started, or a message brought back, while the rest were
  // archived, or one another ask is archiving: up still, and not already said.
  const said = new Set(left.map((s) => s.id));
  for (const ship of toArchive(await deps.runners(mission.id))) {
    if (said.has(ship.id)) continue;
    const why = ship.status === "archiving" ? "it's being archived" : "it started or came back as the others were archived";
    left.push({ id: ship.id, name: shipName(ship), why });
  }
  if (left.length > 0) return refuse(ships, left);

  const runner = await deps.session(mission.id);
  let runnerAnswer: string | ArchivedWithNote | null = null;
  if (runner && runner.status !== "archived") {
    const offer = missionArchiveOffer(runner);
    const answer = runnerAnswer = offer?.can ? await deps.archive(runner).catch(errorText) : offer ? offer.why.replace(/\.$/, "").toLowerCase() : "it isn't running";
    // The Runner's own box out of reach: archived all the same, as a Ship is.
    const why = typeof answer === "string" ? answer : null;
    if (why !== null) {
      const also = unsaved.length > 0 ? ` ${unsavedNote(unsaved)}` : "";
      return { archived: false, ships, left, why: `Its Ships are archived, but the Runner itself couldn't be: ${why}.${also}`, more: false, ...(unsaved.length > 0 && { unsaved }) };
    }
  }
  const runnerUnsaved = runnerAnswer !== null && typeof runnerAnswer === "object";
  const notes = [
    ...(unsaved.length > 0 ? [unsavedNote(unsaved)] : []),
    ...(runnerUnsaved ? ["The Runner itself was archived without its files, its box out of reach."] : []),
  ];
  return { archived: true, ships, ...(unsaved.length > 0 && { unsaved }), ...(notes.length > 0 && { note: notes.join(" ") }) };
}

/** Asks the browser makes, each going on where the last ran out of time:
 *  20 Ships at their slowest take two. */
const MAX_ASKS = 5;

/**
 * Archive the Runner `id` with its Ships, from the browser: asked again while
 * the server only ran out of time. Throws with a sentence to show when it (or
 * one of its Ships) couldn't be; answers what to say once it is, when there's
 * something (Ships archived without their files), else null.
 */
export async function requestMissionArchive(id: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  // Said by asks that ran out of time, kept for the end.
  const notes: string[] = [];
  for (let ask = 1; ; ask++) {
    let res: Response;
    try {
      res = await fetchImpl(`/api/missions/${id}/archive`, { method: "POST" });
    } catch {
      throw new Error("Could not reach Outrunner. Check your connection and try again.");
    }
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; more?: unknown; note?: unknown };
    if (typeof body.note === "string") notes.push(body.note);
    if (res.ok) return notes.length > 0 ? notes.join(" ") : null;
    if (body.more === true && ask < MAX_ASKS) continue;
    const why = typeof body.error === "string" ? body.error : "Could not archive this Runner. Please try again.";
    // A refusal at the end says its own; the earlier asks' notes go with it.
    throw new Error([why, ...notes.filter((n) => !why.includes(n))].join(" "));
  }
}
