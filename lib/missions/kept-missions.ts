import { z } from "zod";

import { store, useStore } from "@/lib/client/store";
import type { MissionView, RunnerView } from "@/lib/missions/view";

/**
 * The owner's Runners kept past the page, in localStorage, so the sidebar's
 * Runners, a Runner's header and the Ships pane paint what they last showed at
 * once — a reload, a deep link, the app's relaunch — rather than a skeleton
 * while GET /api/missions answers (hooks/use-missions.ts).
 *
 * What is kept is what was shown: each Runner with its Ships, their pull
 * requests and where each Ship sits in the pane. Where they stand is not
 * (lib/session/standing.ts): that is the sidebar's live read, looked at again
 * every few seconds, and a mark kept from last time is one the user could act
 * on wrongly. Nothing of a Runner's own page is kept past the page itself:
 * a Ship opened here is held in memory while the page lives, and goes with it
 * ({@link rememberRunnerDetail}).
 *
 * A kept list is a first-paint stand-in and nothing more: the server's answer
 * always wins over it, and it is dropped as the user's own acts make it wrong
 * — a Runner deleted, the org switched, the user signed out. It is
 * read into a `store` so a server render, and so hydration, sees
 * {@link NO_MISSIONS}: nothing reads localStorage while rendering, and the
 * kept Runners land in the first commit after (lib/client/store.ts).
 *
 * The same shape as the sidebar's kept list (lib/session/app-data-cache.ts)
 * and the kept conversations (lib/session/kept-conversations.ts): a versioned
 * entry, validated on the way in, capped by characters, dropped when the store
 * is full rather than left half-written.
 */

/** The Runners as the page has them: the last answer, and why the latest look
 *  failed (the answer before it still shows). */
export type MissionSnapshot = { loaded: boolean; missions: MissionView[]; error: string | null };

/** The empty snapshot: what a server render, and so hydration, shows. */
export const NO_MISSIONS: MissionSnapshot = { loaded: false, missions: [], error: null };

/** One Ship as the Ships pane shows it opened: its brief, its latest response,
 *  and whether it is live (components/missions/runners-pane.tsx). */
export type RunnerDetailView = { brief: string | null; latestResponse: string | null; live: boolean; status: string };

/** How many opened Ships stay here for a re-entry: one just left is the one
 *  likely to be opened again. */
export const DETAILS_HELD = 8;

const KEY = "outrunner:missions";
const VERSION = 1;

/** How many Runners are kept: the ones the sidebar lists. */
export const KEPT_MISSIONS = 50;
/** The most the entry may take, in characters of JSON. One longer isn't kept:
 *  the panes open as they did before, from the server. */
export const KEPT_CHARS = 400_000;

type MissionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What every reader of a kept Runner keys on: the rest of each is carried
 * through as it was written, since the entry is this app's own, put there by
 * this build, and the version is what drops one an older build left.
 *
 * Where a Runner or a Ship stands is required to be absent — nothing keeps
 * it (see the note above) — so an entry holding one is damaged, and is dropped
 * for the server's.
 */
function isRunner(value: unknown): value is RunnerView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.summary === "string" &&
    typeof value.state === "string" &&
    typeof value.group === "string" &&
    typeof value.branch === "string" &&
    (value.attention === null || typeof value.attention === "string") &&
    typeof value.createdAt === "string" &&
    value.standing === null &&
    Array.isArray(value.pulls) &&
    value.pulls.every((pull) => isRecord(pull) && typeof pull.repo === "string" && typeof pull.number === "number" && typeof pull.state === "string")
  );
}

function isMission(value: unknown): value is MissionView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.icon === null || typeof value.icon === "string") &&
    typeof value.status === "string" &&
    typeof value.readyCount === "number" &&
    typeof value.liveRunners === "number" &&
    typeof value.sessionStatus === "string" &&
    typeof value.createdAt === "string" &&
    value.standing === null &&
    (value.environment === null || (isRecord(value.environment) && typeof value.environment.name === "string")) &&
    Array.isArray(value.runners) &&
    value.runners.every(isRunner)
  );
}

const Stored = z.object({ v: z.literal(VERSION), missions: z.array(z.custom<MissionView>(isMission)) });

/**
 * The owner's Runners, as this browser kept them. What the server sent is
 * what goes in, without where anything stands.
 */
export class KeptMissions {
  private readonly storage: () => MissionStorage | null;

  constructor(storage: () => MissionStorage | null) {
    this.storage = storage;
  }

  /** The Runners kept here, if any were and this build can read them. */
  load(): MissionView[] | null {
    const storage = this.storage();
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = Stored.safeParse(parseJson(raw));
    if (!parsed.success) {
      // Kept by an older build, or damaged: the panes open from the server.
      this.clear();
      return null;
    }
    return parsed.data.missions;
  }

  /**
   * Keep `missions` as the answer just read, trimmed to what is worth keeping.
   * Returns what was kept; null when nothing was, and no older copy may stand
   * in for it either.
   */
  save(missions: readonly MissionView[]): MissionView[] | null {
    const storage = this.storage();
    if (!storage) return null;
    const kept = trimmed(missions);
    const json = JSON.stringify({ v: VERSION, missions: kept });
    if (json.length > KEPT_CHARS) {
      // Too long to keep: the panes open from the server.
      this.clear();
      return null;
    }
    try {
      storage.setItem(KEY, json);
      return kept;
    } catch {
      // Out of room: nothing is kept, and no older list stands in for it.
      this.clear();
      return null;
    }
  }

  /** Drop a Runner from the kept list: it was deleted, so what is kept of it
   *  is no longer what the server would say — the list would bring it back. */
  forget(missionId: string): MissionView[] | null {
    const kept = this.load();
    if (!kept) return null;
    return this.save(kept.filter((mission) => mission.id !== missionId));
  }

  /** Forget every kept Runner, for good: whoever looks next isn't shown them. */
  clear(): void {
    const storage = this.storage();
    if (!storage) return;
    try {
      storage.removeItem(KEY);
    } catch {
      // Blocked storage keeps nothing to forget.
    }
  }
}

/** What of a Runner is worth keeping: the ones the sidebar lists, and no
 *  where-anything-stands (which the next look reads again). */
function trimmed(missions: readonly MissionView[]): MissionView[] {
  return missions.slice(0, KEPT_MISSIONS).map((mission) => ({
    ...mission,
    standing: null,
    runners: mission.runners.map((runner) => ({ ...runner, standing: null })),
  }));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function browserStorage(): MissionStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null; // Storage blocked: nothing is kept, the panes open as before.
  }
}

/** This browser's kept Runners. */
export const KEPT_MISSIONS_CACHE = new KeptMissions(browserStorage);

/** Keep the answer just read, for the panes' next cold start. */
export function rememberMissions(missions: readonly MissionView[]): void {
  KEPT_MISSIONS_CACHE.save(missions);
}

/** A Runner's kept copy goes with it: it was deleted. */
export function forgetKeptMission(missionId: string): void {
  KEPT_MISSIONS_CACHE.forget(missionId);
}

/** The Runners kept here, as the page starts from them; null when nothing
 *  was kept, which is a first visit: the panes show their skeletons. */
function keptSnapshot(): MissionSnapshot {
  const kept = KEPT_MISSIONS_CACHE.load();
  return kept ? { loaded: true, missions: kept, error: null } : NO_MISSIONS;
}

/**
 * The Runners the whole page shows: the last answer, or what was kept until
 * one comes. Read through a `store` so a server render — and hydration — sees
 * {@link NO_MISSIONS} and the kept Runners land in the first commit after.
 */
const MISSIONS = store<MissionSnapshot>(keptSnapshot());

/** Bumped by {@link clearMissions}: a look started before it answers too late
 *  to count, so the org left behind can't be published into the new one. */
let generation = 0;

/** Whether the server has answered since {@link clearMissions}. False while
 *  what is shown is what was kept. */
let answered = false;

/** The Runners as the page has them now. */
export function missionsSnapshot(): MissionSnapshot {
  return MISSIONS.get();
}

/** The Runners as the page has them, for every component that shows them. */
export function useMissionsSnapshot(): MissionSnapshot {
  return useStore(MISSIONS, NO_MISSIONS);
}

/** The generation a look was started in, to publish by (see the export). */
export function missionsGeneration(): number {
  return generation;
}

/** Whether what the store holds is the server's own answer, rather than what
 *  was kept until one comes. Read beside {@link missionsSnapshot}. */
export function missionsAnswered(): boolean {
  return answered;
}

/** Publish an answer. The server's always wins over what was kept. */
export function publishMissions(next: MissionSnapshot): void {
  // An answer, not a look that failed: only then do the Runners shown stand
  // for the whole list rather than for what was kept of it.
  if (next.error === null) answered = next.loaded;
  MISSIONS.set(next);
}

/**
 * The Ships opened here, most recently opened last (a Map keeps that order),
 * and never more than {@link DETAILS_HELD}. These are not kept past the page:
 * a Ship is opened by a click, never by the page coming back, so there is
 * nothing to paint on a cold start — what this buys is opening one again
 * without its "Latest response" loading first.
 */
const opened = new Map<string, RunnerDetailView>();

/** The opened Ships, as a value: replaced on every change, since
 *  useSyncExternalStore re-renders forever on a new object per read. */
const OPENED = store<ReadonlyMap<string, RunnerDetailView>>(new Map());

/** The opened Ships' empty snapshot: what a server render shows. */
const NO_OPENED: ReadonlyMap<string, RunnerDetailView> = new Map();

/** One Ship as it was last read here, or null. The server's answer replaces
 *  it as it lands. */
export function useKeptRunnerDetail(runnerId: string): RunnerDetailView | null {
  return useStore(OPENED, NO_OPENED).get(runnerId) ?? null;
}

/** The same, read outside a component. */
export function runnerDetail(runnerId: string): RunnerDetailView | null {
  return opened.get(runnerId) ?? null;
}

/** Keep a Ship as the server just answered it: opening it again paints from
 *  this. */
export function rememberRunnerDetail(runnerId: string, detail: RunnerDetailView): void {
  opened.delete(runnerId);
  opened.set(runnerId, detail);
  while (opened.size > DETAILS_HELD) opened.delete(opened.keys().next().value as string);
  OPENED.set(new Map(opened));
}

/** Forget the Runners on screen and the ones kept, and turn away any look
 *  still in flight: the user signed out, or switched orgs, and one org's
 *  Runners must never stand in for another's. */
export function clearMissions(): void {
  generation += 1;
  answered = false;
  KEPT_MISSIONS_CACHE.clear();
  MISSIONS.set(NO_MISSIONS);
  opened.clear();
  OPENED.set(NO_OPENED);
}
