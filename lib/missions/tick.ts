/**
 * Missions on the sessions tick (every 2 minutes, after the sessions' own
 * reads, app/api/sessions/tick): whatever the watches right after a send
 * and the webhooks didn't finish. Each part bounded and logged, never thrown,
 * so one failing doesn't stop the others; each safe to run twice at once.
 *
 *   turns       Runners' turns not looked at lately, for their end
 *   pull reqs   Runners' pull requests due a decision, and ones no webhook
 *               announced
 *   queued      messages held for a Runner whose turn ended meanwhile
 *   deliveries  events waiting for their Mission, retried with backoff
 */

import { deliverNow, missionsWithPendingEvents } from "@/lib/missions/outbox.deps";
import { settleDueRunners } from "@/lib/missions/pull-requests";
import { checkStaleWatches, sendWaitingQueued } from "@/lib/missions/watch.deps";

async function quietly<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.error(`Missions tick: ${label} failed`, error);
    return null;
  }
}

export async function runMissionTick(): Promise<{ turns: number; pullRequests: number; queued: number; delivered: number }> {
  const [turns, pullRequests, queued] = await Promise.all([
    quietly("turns", () => checkStaleWatches()),
    quietly("pull requests", () => settleDueRunners()),
    quietly("queued messages", () => sendWaitingQueued()),
  ]);
  // Last: what the parts above recorded goes in the same tick.
  const delivered = await quietly("deliveries", async () => {
    let count = 0;
    for (const missionId of await missionsWithPendingEvents()) count += await deliverNow(missionId);
    return count;
  });
  return { turns: turns ?? 0, pullRequests: pullRequests ?? 0, queued: queued ?? 0, delivered: delivered ?? 0 };
}
