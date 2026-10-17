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
 * The I/O is behind {@link ReconcileDeps}, so the rules are tested alone.
 */

import type { Activity } from "@/lib/runtime/agent-protocol";
import type { MeteredComputer, OpenInterval } from "@/lib/billing/metering-store";

/** No activity for this long, and no turn in progress: the box is paused. */
export const IDLE_AFTER_MS = 15 * 60_000;
/**
 * A turn that has been "in progress" this long with nothing happening is
 * taken as stuck (Claude killed mid-turn leaves one open forever), so it no
 * longer keeps the box up. Long enough for any quiet tool run.
 */
export const STUCK_TURN_AFTER_MS = 2 * 60 * 60_000;
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
 *  couldn't say (one from before /activity, or unreachable): never paused. */
export type BoxState = { running: false } | { running: true; activity: Activity | null };

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
  openInterval(computer: MeteredComputer, at: Date): Promise<void>;
  touchIntervals(ids: string[], at: Date): Promise<void>;
  closeInterval(id: string, at: Date): Promise<void>;
  log(message: string, error?: unknown): void;
};

export type ReconcileReport = {
  /** Another server held the lease: this run did nothing. */
  skipped: boolean;
  seen: number;
  paused: number;
  lost: number;
  /** Intervals closed for boxes no ready computer has. */
  closed: number;
  failed: number;
  /** Left for the next run, out of time in this one. */
  deferred: number;
};

/** Whether a box doing `activity` is idle at `now`. */
export function isIdle(activity: Activity | null, now: Date): boolean {
  if (!activity) return false;
  const last = Date.parse(activity.lastActivity);
  if (!Number.isFinite(last)) return false;
  const quietMs = now.getTime() - last;
  return quietMs >= (activity.turnInProgress ? STUCK_TURN_AFTER_MS : IDLE_AFTER_MS);
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { skipped: false, seen: 0, paused: 0, lost: 0, closed: 0, failed: 0, deferred: 0 };
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
      if (interval) seenIds.push(interval.id);
      else await deps.openInterval(computer, now);
    } catch (error) {
      // One box's trouble mustn't stop the rest; its interval stays open, and
      // is counted no further than it was last seen.
      deps.log(`Reconcile: computer ${computer.id} (box ${computer.sandboxId}) failed`, error);
      report.failed += 1;
    }
  });

  await deps.touchIntervals(seenIds, deps.now());

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

/** Run `work` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}
