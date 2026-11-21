/**
 * The learnings' actions (lib/learnings/actions.ts) wired to the database:
 * the store, the org's audit log, and who a caller is in an org. Kept apart
 * so the actions stay free of the database and unit-testable.
 */

import { type AuditActor } from "@/lib/audit/actions";
import { recordAudit } from "@/lib/audit/record";
import { learningStore } from "@/lib/db/learnings";
import { getOrg, memberRole } from "@/lib/db/orgs";
import type { LearningDeps } from "@/lib/learnings/actions";
import type { LearningActor } from "@/lib/learnings/rules";

/** The actions' deps, recording org changes as `actor` made them. */
export function learningDeps(actor: AuditActor): LearningDeps {
  return {
    store: learningStore,
    audit: (action, learning) =>
      recordAudit({
        orgId: learning.orgId as string,
        actor,
        action,
        resource: { type: "learning", id: learning.id, label: learning.title },
      }),
  };
}

/** `userId` as a learnings actor in `orgId`, or null when they aren't one
 *  of its members. */
export async function learningActor(userId: string, orgId: string): Promise<LearningActor | null> {
  const role = await memberRole(orgId, userId);
  return role ? { userId, orgId, role } : null;
}
