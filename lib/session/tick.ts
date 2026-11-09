/**
 * The sessions tick (POST /api/sessions/tick, every two minutes from the
 * Cloudflare cron): reads what's new on every session whose box is up, and
 * checks open pull requests against GitHub, so where each session stands
 * (lib/session/standing.ts) stays true without anyone watching it. What it
 * sees that's news is recorded as notifications (lib/notifications/record.ts),
 * with sessions that failed lately, and then sent by email and Slack to those
 * who want them (lib/notifications/deliver.ts).
 */

import { deliverNotifications, type DeliveryReport } from "@/lib/notifications/deliver";
import { notifyActivity, notifyFailures, notifyPullRequests } from "@/lib/notifications/record";
import { checkOpenPullRequests } from "@/lib/session/pull-request-state";
import { tellTrackersPullRequests } from "@/lib/trackers/write-back.deps";
import { inPool } from "@/lib/session/pool";
import { readSession, watchedSessions, type ActivityChange } from "@/lib/session/watch";

/** Streams read at once: each read waits a moment of quiet to be sure it's
 *  caught up. */
const READ_WIDTH = 8;

/** No read starts after this much of a tick: the cron calls every two
 *  minutes, and a tick that ran into the next would double the load on boxes
 *  just when they're busiest. The sessions left are the least recently
 *  active, read on a quieter tick. */
const READ_BUDGET_MS = 90_000;

export type TickReport = {
  read: number;
  changed: number;
  pullRequests: number;
  skipped: number;
  failures: number;
  delivered: DeliveryReport | null;
};

export async function runSessionsTick(
  onChange: (change: ActivityChange) => Promise<void> = (change) => notifyActivity(change),
): Promise<TickReport> {
  const report: TickReport = { read: 0, changed: 0, pullRequests: 0, skipped: 0, failures: 0, delivered: null };
  // A listing that fails skips the reads this round, not the pull requests'
  // check below, which doesn't depend on it.
  const sessions = await watchedSessions().catch((error: unknown) => {
    console.error("Sessions tick: couldn't list sessions", error);
    return [] as string[];
  });
  const { started } = await inPool(sessions, READ_WIDTH, async (id) => {
    const change = await readSession(id).catch((error: unknown) => {
      console.error(`Sessions tick: couldn't read ${id}`, error);
      return null;
    });
    if (!change) return;
    report.read += 1;
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      report.changed += 1;
      await onChange(change).catch((error: unknown) => console.error(`Sessions tick: ${id}'s change`, error));
    }
  }, { until: Date.now() + READ_BUDGET_MS });
  report.skipped = sessions.length - started;
  const pullRequests = await checkOpenPullRequests().catch((error: unknown) => {
    console.error("Sessions tick: couldn't check pull requests", error);
    return [];
  });
  report.pullRequests = pullRequests.length;
  await tellTrackersPullRequests(pullRequests);
  await notifyPullRequests(pullRequests).catch((error: unknown) => console.error("Sessions tick: pull request news", error));
  report.failures = await notifyFailures().catch((error: unknown) => {
    console.error("Sessions tick: couldn't look for failed sessions", error);
    return 0;
  });
  report.delivered = await deliverNotifications().catch((error: unknown) => {
    console.error("Sessions tick: couldn't deliver notifications", error);
    return null;
  });
  return report;
}
