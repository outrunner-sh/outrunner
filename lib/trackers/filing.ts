/** Who a tracker's rule files an issue as. */

import type { TrackerRule } from "@/lib/trackers/rules";
import { canCapture, type TriageActor } from "@/lib/triage/access";

export type FilingDeps = {
  linkedOwner(installationId: string, externalUserId: string): Promise<string | null>;
  triageActor(userId: string, orgId: string): Promise<TriageActor | null>;
};

/**
 * The issue's author if they're linked and may, otherwise whoever set the rule. A rule
 * whose setter has left or can no longer file there stops, whoever the author is: an admin
 * finds out from its card rather than from issues that only sometimes arrive.
 */
export async function filingActor(installationId: string, rule: TrackerRule, authorId: string | null, orgId: string, deps: FilingDeps): Promise<TriageActor | null> {
  const setter = rule.setBy ? await deps.triageActor(rule.setBy, orgId) : null;
  if (!setter || !canCapture(setter, rule.projectId)) return null;
  const owner = authorId ? await deps.linkedOwner(installationId, authorId) : null;
  const author = owner ? await deps.triageActor(owner, orgId) : null;
  return author && canCapture(author, rule.projectId) ? author : setter;
}
