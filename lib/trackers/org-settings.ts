/** What a tracker's settings page shows. */

import { orgTrackers, type OrgTracker, type TrackerScope } from "@/lib/db/trackers";
import { triageActor } from "@/lib/db/work-items";
import type { TrackerProvider, TrackerRule } from "@/lib/trackers/rules";
import { canCapture, type TriageActor } from "@/lib/triage/access";

export type SettingsRule = TrackerRule & { stopped: boolean };
export type SettingsScope = TrackerScope & { rules: SettingsRule[] };
export type SettingsTracker = Omit<OrgTracker, "scopes"> & {
  scopes: SettingsScope[];
  /** Jira's webhook is missing or out of time, so nothing is arriving. */
  webhookProblem: boolean;
};

/** A connected Jira site with projects that nothing is arriving from. */
export function jiraWebhookProblem(tracker: Pick<OrgTracker, "provider" | "disconnected" | "webhookId" | "webhookExpiresAt"> & { scopes: unknown[] }, now = Date.now()): boolean {
  if (tracker.provider !== "jira" || tracker.disconnected || tracker.scopes.length === 0) return false;
  return !tracker.webhookId || !tracker.webhookExpiresAt || Date.parse(tracker.webhookExpiresAt) <= now;
}

/** The org's workspaces or sites, each rule saying if it has stopped: whoever set it has
 *  left, or can no longer file where it files. */
export async function trackersWithStoppedRules(orgId: string, provider: TrackerProvider): Promise<SettingsTracker[]> {
  const trackers = await orgTrackers(orgId, provider);
  const setters = new Set(trackers.flatMap((t) => t.scopes.flatMap((s) => s.rules.map((r) => r.setBy))).filter((id): id is string => id !== null));
  const actors = new Map<string, TriageActor | null>(
    await Promise.all([...setters].map(async (id) => [id, await triageActor(id, orgId)] as const)),
  );
  return trackers.map((tracker) => ({
    ...tracker,
    webhookProblem: jiraWebhookProblem(tracker),
    scopes: tracker.scopes.map((scope) => ({
      ...scope,
      rules: scope.rules.map((rule) => {
        const setter = rule.setBy ? actors.get(rule.setBy) : null;
        return { ...rule, stopped: !setter || !canCapture(setter, rule.projectId) };
      }),
    })),
  }));
}
