/**
 * What the trackers' tick does (app/api/integrations/trackers/tick): refresh the
 * tokens that are due while they still work, forget old events, and pass on delegated
 * sessions' replies that outlast their first watch. One install failing doesn't stop
 * the rest.
 */

import { clearStaleJiraText } from "@/lib/db/jira-sessions";
import { clearStaleAgentText } from "@/lib/db/linear-agent";
import { installationsDueForRefresh, pruneTrackerEvents } from "@/lib/db/trackers";
import { relayJiraAwaited } from "@/lib/trackers/jira-relay";
import { refreshAllJiraWebhooks } from "@/lib/trackers/jira-webhooks.deps";
import { relayLinearAwaited } from "@/lib/trackers/linear-relay";
import { refreshIfDue, REFRESH_MARGIN_MS, TrackerDisconnectedError } from "@/lib/trackers/tokens";
import { tokenDeps } from "@/lib/trackers/tokens.deps";

/** Longer than any redelivery: Linear's last is after 6 hours. */
const EVENTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** Issue text and comments kept for a question that's waiting. */
const ASKS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

export async function runTrackersTick(now = Date.now()): Promise<{ refreshed: number; failed: number; relayed: number; webhooks: number }> {
  let refreshed = 0;
  let failed = 0;
  for (const provider of ["linear", "jira"] as const) {
    for (const id of await installationsDueForRefresh(provider, now + REFRESH_MARGIN_MS[provider])) {
      try {
        if (await refreshIfDue(id, provider, tokenDeps)) refreshed += 1;
      } catch (error) {
        // Marked disconnected already, and the card says so.
        if (error instanceof TrackerDisconnectedError) continue;
        failed += 1;
        console.error(`Trackers: couldn't refresh install ${id}`, error);
      }
    }
  }
  const webhooks = await refreshAllJiraWebhooks();
  await pruneTrackerEvents(now - EVENTS_KEPT_MS);
  await clearStaleAgentText(now - ASKS_KEPT_MS);
  await clearStaleJiraText(now - ASKS_KEPT_MS);
  const relayed = (await relayLinearAwaited()) + (await relayJiraAwaited());
  return { refreshed, failed, relayed, webhooks };
}
