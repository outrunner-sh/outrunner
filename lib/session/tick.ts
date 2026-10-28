/**
 * The sessions tick (POST /api/sessions/tick, every two minutes from the
 * Cloudflare cron): reads what's new on every session whose box is up, and
 * checks open pull requests against GitHub, so where each session stands
 * (lib/session/standing.ts) stays true without anyone watching it.
 */

import { checkOpenPullRequests } from "@/lib/session/pull-request-state";
import { inBatches, readSession, watchedSessions, type ActivityChange } from "@/lib/session/watch";

/** Streams read at once: each read waits a moment of quiet to be sure it's
 *  caught up. */
const READ_WIDTH = 8;

export type TickReport = { read: number; changed: number; pullRequests: number };

export async function runSessionsTick(onChange?: (change: ActivityChange) => Promise<void>): Promise<TickReport> {
  const report: TickReport = { read: 0, changed: 0, pullRequests: 0 };
  const sessions = await watchedSessions();
  await inBatches(sessions, READ_WIDTH, async (id) => {
    const change = await readSession(id).catch((error: unknown) => {
      console.error(`Sessions tick: couldn't read ${id}`, error);
      return null;
    });
    if (!change) return;
    report.read += 1;
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      report.changed += 1;
      await onChange?.(change).catch((error: unknown) => console.error(`Sessions tick: ${id}'s change`, error));
    }
  });
  report.pullRequests = (
    await checkOpenPullRequests().catch((error: unknown) => {
      console.error("Sessions tick: couldn't check pull requests", error);
      return [];
    })
  ).length;
  return report;
}
