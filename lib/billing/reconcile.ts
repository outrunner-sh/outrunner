/**
 * The reconciler: run every couple of minutes (a Cloudflare cron calls
 * POST /api/billing/reconcile), it keeps cloud hours true to what Outrunner's
 * boxes do, and pauses the idle ones.
 *
 * Each run, for every ready computer on a box Outrunner pays for:
 *   - a box that isn't running any more ends its interval where it was last
 *     seen, and the computer is marked stopped;
 *   - a running one gets an open interval (if a provision's didn't open one)
 *     seen now;
 *   - an idle one is paused, keeping its disk, and its interval ends now. The
 *     next session brings it back (lib/runtime/sandbox-choice.ts, restore).
 * And an interval left open for a box no ready computer has ends where it was
 * last seen.
 *
 * A box that never reads idle is still not left to bill for ever: it is
 * paused anyway ({@link forcedPause}) when its agent hasn't answered for
 * {@link UNREACHABLE_PAUSE_MS}, when it has been "in a turn" with no activity
 * for {@link STUCK_TURN_PAUSE_MS}, or when it has run {@link MAX_BOX_RUN_MS}
 * at a stretch with no recent activity, or {@link MAX_BOX_RUN_HARD_MS} even
 * with it. Each is logged with its workspace and why, and its session
 * says why (a notice on the workspace, cleared once its box runs again). And
 * every box kept running is heartbeated to the provider (keepAlive), whose
 * own idle stop (Daytona's, lib/runtime/sandbox/daytona.ts AUTO_STOP_MINUTES)
 * stops it should these runs ever stop.
 *
 * The I/O is behind {@link ReconcileDeps}, so the rules are tested alone.
 */

import type { Activity } from "@/lib/runtime/agent-protocol";
import type { MeteredComputer, OpenInterval } from "@/lib/billing/metering-store";

/** No activity for this long, and no turn in progress: the box is paused. */
export const IDLE_AFTER_MS = 15 * 60_000;
/**
 * The forced pauses' limits, for a box that never reads idle. Generous: each
 * pauses (never deletes) the box, and its session resumes it on the next
 * message, but one paused mid-turn loses that turn.
 *
 * Unreachable: no answer from its agent for this long (crashed, its secret
 * won't open, an agent from before /activity). An agent restarting or a
 * network blip lasts minutes, not hours.
 */
export const UNREACHABLE_PAUSE_MS = 3 * 60 * 60_000;
/** Stuck in a turn: its agent says a turn is in progress (or can't say it
 *  isn't: an older agent) but nothing has happened on it for this long. A
 *  real turn's tools, output and messages are activity; a build or test run
 *  silent for 6 hours is not one to keep paying for. */
export const STUCK_TURN_PAUSE_MS = 6 * 60 * 60_000;
/** The longest a box runs at a stretch (since it last started) unless it's
 *  in active use: activity within {@link ACTIVE_WITHIN_MS}, which holds the
 *  pause off so a long session isn't cut mid-turn. Its session resumes it. */
export const MAX_BOX_RUN_MS = 12 * 60 * 60_000;
/** The hard cap on one run, active or not: past it the box is paused even
 *  mid-turn, and that turn is lost. The tradeoff is deliberate: a loop that
 *  keeps producing activity would otherwise bill for ever. */
export const MAX_BOX_RUN_HARD_MS = 16 * 60 * 60_000;
/** Activity this recent counts as the box in use, for the run cap. */
export const ACTIVE_WITHIN_MS = IDLE_AFTER_MS;

/** Why a box that isn't idle is paused anyway, and what its session says. */
export type ForcedPause = { reason: "unreachable" | "stuck-turn" | "max-run"; notice: string };

/** A session's notice that its box was paused by one of these: a prefix the
 *  reconciler clears once the box runs again. */
export const FORCED_PAUSE_NOTICE_PREFIX = "Its box was paused";

const hours = (ms: number) => Math.round(ms / (60 * 60_000));

/** Shorter than the cron's period. */
export const LEASE_SECONDS = 90;
/**
 * No box is started on past this far into a run, so the run is done before
 * its lease expires and the next one can't work from an older snapshot: the
 * boxes left over wait for the next run. The margin covers the slowest box
 * already under way (an agent's 12s timeout, plus the provider's calls).
 */
export const RUN_DEADLINE_MS = (LEASE_SECONDS - 30) * 1000;
/** How many boxes are asked about at once. */
const CONCURRENCY = 5;

/** What the reconciler found a box doing. `activity` is null when its agent
 *  couldn't say: never paused as idle. `reachable` is whether its agent
 *  answered at all: an agent from before /activity answers it 404, and is
 *  reachable; one that didn't answer is not, and is paused only by the
 *  unreachable limit. A reading implies reachable. */
export type BoxState = { running: false } | { running: true; activity: Activity | null; reachable?: boolean };

/** The box's run so far, from its open interval: when it started, and when
 *  its agent last answered (null: not this run; undefined: not recorded, a
 *  database from before agent_seen_at, so the unreachable limit is off). */
export type BoxRun = Pick<OpenInterval, "startedAt" | "agentSeenAt">;

export type ReconcileDeps = {
  /** Whether idle boxes are paused, or only metered: not where the provider
   *  can't bring a paused box back (the jcode engine). */
  pausesIdleBoxes: boolean;
  now(): Date;
  claimLease(): Promise<boolean>;
  readyComputers(): Promise<MeteredComputer[]>;
  openIntervals(): Promise<OpenInterval[]>;
  observe(computer: MeteredComputer): Promise<BoxState>;
  pause(computer: MeteredComputer): Promise<void>;
  markStopped(computer: MeteredComputer, reason: string): Promise<void>;
  /** Tell the computer's session why its box was paused (a forced pause). */
  noticeSession(computer: MeteredComputer, notice: string): Promise<void>;
  /** Clear that notice from these computers' sessions: their boxes run again. */
  clearNotices(computers: MeteredComputer[]): Promise<void>;
  /** Reset the provider's own idle stop for a box kept running. */
  keepAlive(computer: MeteredComputer): Promise<void>;
  openInterval(computer: MeteredComputer, at: Date): Promise<void>;
  /** The intervals' boxes were seen running at `at`; those of `answered`
   *  had their agent answer too. */
  touchIntervals(ids: string[], at: Date, answered: string[]): Promise<void>;
  closeInterval(id: string, at: Date): Promise<void>;
  log(message: string, error?: unknown): void;
};

export type ReconcileReport = {
  /** Another server held the lease: this run did nothing. */
  skipped: boolean;
  seen: number;
  paused: number;
  /** Of `paused`, those paused by a limit, not idle (forcedPause). */
  forced: number;
  lost: number;
  /** Intervals closed for boxes no ready computer has. */
  closed: number;
  failed: number;
  /** Left for the next run, out of time in this one. */
  deferred: number;
};

/** Whether a box doing `activity` is idle at `now`. */
export function isIdle(activity: Activity | null, now: Date): boolean {
  // Silence, browser disconnects, and user absence do not finish agent work.
  // Older agents can mistake commentary for completion: never pause on their report.
  if (!activity || activity.turnInProgress || activity.turnTrackingVersion !== 1) return false;
  const last = Date.parse(activity.lastActivity);
  if (!Number.isFinite(last)) return false;
  const quietMs = now.getTime() - last;
  return quietMs >= IDLE_AFTER_MS;
}

/** Whether `activity` is a reading at all: an agent that answered, with a
 *  time. */
function answered(activity: Activity | null): activity is Activity {
  return activity !== null && Number.isFinite(Date.parse(activity.lastActivity));
}

/**
 * Why a running box that isn't idle is to be paused anyway at `now`, or null.
 * `run` is its open interval (none yet: a box seen for the first time, never
 * forced). Exported for tests.
 */
export function forcedPause(
  activity: Activity | null,
  run: BoxRun | undefined,
  now: Date,
  /** Its agent answered, if without a reading (one from before /activity). */
  reachable = false,
): ForcedPause | null {
  if (!run) return null;
  const at = now.getTime();
  const ran = at - run.startedAt.getTime();
  const inUse = answered(activity) && at - Date.parse(activity.lastActivity) < ACTIVE_WITHIN_MS;
  if (ran >= MAX_BOX_RUN_HARD_MS || (ran >= MAX_BOX_RUN_MS && !inUse)) {
    return {
      reason: "max-run",
      notice:
        ran >= MAX_BOX_RUN_HARD_MS
          ? `${FORCED_PAUSE_NOTICE_PREFIX} after ${hours(MAX_BOX_RUN_HARD_MS)} hours running, the longest one runs at a stretch. Its files are kept; send a message to start it again.`
          : `${FORCED_PAUSE_NOTICE_PREFIX} after ${hours(MAX_BOX_RUN_MS)} hours running with no recent activity. Its files are kept; send a message to start it again.`,
    };
  }
  // An agent that answers without a reading (from before /activity) can't
  // say it's stuck: only the run cap stops it.
  if (!answered(activity) && reachable) return null;
  if (!answered(activity)) {
    // Not recorded (undefined): off, rather than measured from the run's start.
    if (run.agentSeenAt === undefined) return null;
    const since = (run.agentSeenAt ?? run.startedAt).getTime();
    if (at - since < UNREACHABLE_PAUSE_MS) return null;
    return {
      reason: "unreachable",
      notice: `${FORCED_PAUSE_NOTICE_PREFIX}: its agent hadn't answered for ${hours(UNREACHABLE_PAUSE_MS)} hours. Its files are kept; send a message to start it again.`,
    };
  }
  if (isIdle(activity, now)) return null;
  const quietMs = at - Date.parse(activity.lastActivity);
  if (quietMs < STUCK_TURN_PAUSE_MS) return null;
  return {
    reason: "stuck-turn",
    notice: `${FORCED_PAUSE_NOTICE_PREFIX}: its agent had shown no activity for ${hours(STUCK_TURN_PAUSE_MS)} hours in a turn that never ended. Its files are kept; send a message to start it again.`,
  };
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { skipped: false, seen: 0, paused: 0, forced: 0, lost: 0, closed: 0, failed: 0, deferred: 0 };
  if (!(await deps.claimLease())) return { ...report, skipped: true };
  const deadline = deps.now().getTime() + RUN_DEADLINE_MS;

  const [computers, open] = await Promise.all([deps.readyComputers(), deps.openIntervals()]);
  const openByBox = new Map(open.map((interval) => [interval.sandboxId, interval]));
  // Each ready computer's interval is its own, looked at or not this run;
  // what's left is open for a box no ready computer has.
  const intervalOf = new Map<string, OpenInterval>();
  for (const computer of computers) {
    const interval = openByBox.get(computer.sandboxId);
    if (interval) intervalOf.set(computer.id, interval);
    openByBox.delete(computer.sandboxId);
  }
  const seenIds: string[] = [];
  const answeredIds: string[] = [];
  const running: MeteredComputer[] = [];
  // Longest unseen first: a run that runs out of time leaves the boxes it
  // saw, so the ones it didn't get to come first next time, not last again.
  // A box with no interval yet has never been seen.
  const lastSeen = (computer: MeteredComputer) => intervalOf.get(computer.id)?.lastSeenAt.getTime() ?? -Infinity;
  const queue = [...computers].sort((a, b) => lastSeen(a) - lastSeen(b));

  await eachLimited(queue, CONCURRENCY, async (computer) => {
    if (deps.now().getTime() >= deadline) {
      report.deferred += 1;
      return;
    }
    const interval = intervalOf.get(computer.id);
    try {
      const state = await deps.observe(computer);
      const now = deps.now();
      if (!state.running) {
        if (interval) await deps.closeInterval(interval.id, interval.lastSeenAt);
        await deps.markStopped(computer, "Runtime Computer is no longer available and will be reprovisioned.");
        report.lost += 1;
        return;
      }
      report.seen += 1;
      // Asked again just before pausing: someone may have started work since.
      // What's left of that window heals itself: a session that attached in it
      // finds the box paused on its next request and resumes it.
      if (deps.pausesIdleBoxes && isIdle(state.activity, now) && (await stillIdle(deps, computer))) {
        await deps.pause(computer);
        if (interval) await deps.closeInterval(interval.id, now);
        await deps.markStopped(computer, "Paused while idle; it resumes with the next session.");
        report.paused += 1;
        return;
      }
      // Not idle, but past a limit: paused anyway, asked again first as an
      // idle one is (an agent back, a turn that moved on).
      const forced = deps.pausesIdleBoxes ? forcedPause(state.activity, interval, now, state.reachable) : null;
      if (forced && (await stillForced(deps, computer, interval))) {
        deps.log(
          `Reconcile: forced pause (${forced.reason}) of workspace ${computer.workspaceId ?? "none"}, computer ${computer.id} (box ${computer.sandboxId}, owner ${computer.ownerId})`,
        );
        await deps.pause(computer);
        if (interval) await deps.closeInterval(interval.id, now);
        await deps.markStopped(computer, forced.notice);
        await deps.noticeSession(computer, forced.notice).catch((error: unknown) =>
          deps.log(`Reconcile: couldn't tell workspace ${computer.workspaceId} why its box was paused`, error),
        );
        report.paused += 1;
        report.forced += 1;
        return;
      }
      if (interval) {
        seenIds.push(interval.id);
        if (answered(state.activity) || state.reachable) answeredIds.push(interval.id);
      } else await deps.openInterval(computer, now);
      running.push(computer);
      // The provider's own stop is only for boxes no one looks after: this
      // one is looked after. A failure here costs nothing yet (hours of slack).
      await deps.keepAlive(computer).catch((error: unknown) =>
        deps.log(`Reconcile: couldn't heartbeat box ${computer.sandboxId}`, error),
      );
    } catch (error) {
      // One box's trouble mustn't stop the rest; its interval stays open, and
      // is counted no further than it was last seen.
      deps.log(`Reconcile: computer ${computer.id} (box ${computer.sandboxId}) failed`, error);
      report.failed += 1;
    }
  });

  await deps.touchIntervals(seenIds, deps.now(), answeredIds);
  // A forced pause's notice is stale once its box runs again.
  await deps.clearNotices(running).catch((error: unknown) => deps.log("Reconcile: couldn't clear pause notices", error));

  // Open for a box no ready computer has: it was deleted, replaced, or its
  // computer stopped some other way.
  for (const interval of openByBox.values()) {
    await deps.closeInterval(interval.id, interval.lastSeenAt);
    report.closed += 1;
  }
  return report;
}

/** Whether the box is still running and idle, asked now. */
async function stillIdle(deps: ReconcileDeps, computer: MeteredComputer): Promise<boolean> {
  const state = await deps.observe(computer);
  return state.running && isIdle(state.activity, deps.now());
}

/** Whether the box is still to be paused by a limit, asked now. */
async function stillForced(deps: ReconcileDeps, computer: MeteredComputer, run: BoxRun | undefined): Promise<boolean> {
  const state = await deps.observe(computer);
  return state.running && forcedPause(state.activity, run, deps.now(), state.reachable) !== null;
}

/** Run `work` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}
