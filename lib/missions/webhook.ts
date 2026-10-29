/**
 * The GitHub webhook's part for Missions (app/api/github/webhook): activity on
 * a Runner's pull request noted, and one merged or closed decided at once, so
 * its Mission hears without waiting for the tick. Never throws: GitHub isn't
 * asked to deliver again for this; the tick looks anyway.
 */

import { activityOf, notePullRequestActivity, settleRunner } from "@/lib/missions/pull-requests";
import { sessionById } from "@/lib/missions/store";

export async function followPullRequestActivity(event: string | null, payload: Record<string, unknown>): Promise<void> {
  try {
    const activity = activityOf(event, payload);
    if (!activity) return;
    const touched = await notePullRequestActivity(activity);
    if (activity.pr?.state === "merged" || activity.pr?.state === "closed") {
      for (const id of touched) {
        const runner = await sessionById(id);
        if (runner) await settleRunner(runner);
      }
    }
  } catch (error) {
    console.error(`Missions: following ${event} failed`, error);
  }
}
