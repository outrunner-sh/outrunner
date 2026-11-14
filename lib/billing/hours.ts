/**
 * The intervals Outrunner's boxes ran (compute_intervals), as runs: what
 * usage is priced from (lib/billing/usage.ts). Pure, so the counting rules
 * are tested without a database.
 */

export type Interval = {
  sandboxId: string;
  cpu: number;
  startedAt: Date;
  /** The last time the box was seen running. */
  lastSeenAt: Date;
  /** Null while it runs. */
  endedAt: Date | null;
};

export type Period = { start: Date; end: Date };

/** A Small box's vCPUs: one of its hours is one hour. */
export const SMALL_BOX_CPU = 2;

/**
 * How long past its last sighting an open interval is still counted to now.
 * The reconciler sees each box every couple of minutes; one not seen for
 * longer may have stopped unseen, so it is counted to when it was last seen,
 * in the user's favour, until it is seen again.
 */
export const OPEN_GRACE_MS = 5 * 60_000;

/** The calendar month (UTC) `now` is in: the period of a monthly plan with
 *  no subscription period of its own (a contract, the connector). */
export function calendarMonth(now: Date): Period {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** A box's continuous run: one session. Open while any interval in it is. */
export type Run = { start: number; end: number; cpu: number; open: boolean };

/** Where an interval ends for counting: when it ended; while open, now, or
 *  its last sighting once that is too long ago. */
function endOf(interval: Interval, now: Date): number {
  if (interval.endedAt) return interval.endedAt.getTime();
  const seen = interval.lastSeenAt.getTime();
  return Math.min(now.getTime(), seen + OPEN_GRACE_MS);
}

/**
 * The intervals as runs, with overlapping ones of the same box merged: a box
 * runs once at a time, so a moment two of its intervals share (a bad close, a
 * race) counts once. A box keeps its size, so a merged run takes the larger
 * if two disagree. Different boxes' runs overlap and each counts.
 */
export function mergedRuns(intervals: readonly Interval[], now: Date): Run[] {
  const byBox = new Map<string, Run[]>();
  for (const interval of intervals) {
    const run = { start: interval.startedAt.getTime(), end: endOf(interval, now), cpu: interval.cpu, open: interval.endedAt === null };
    if (run.end <= run.start) continue;
    byBox.set(interval.sandboxId, [...(byBox.get(interval.sandboxId) ?? []), run]);
  }
  const merged: Run[] = [];
  for (const runs of byBox.values()) {
    runs.sort((a, b) => a.start - b.start);
    let current = { ...runs[0] };
    for (const run of runs.slice(1)) {
      if (run.start <= current.end) {
        current.end = Math.max(current.end, run.end);
        current.cpu = Math.max(current.cpu, run.cpu);
        current.open = current.open || run.open;
      } else {
        merged.push(current);
        current = { ...run };
      }
    }
    merged.push(current);
  }
  return merged;
}
