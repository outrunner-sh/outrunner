/**
 * A project's changes in its org's audit log (lib/audit/actions.ts
 * `project.*`), which are also its history (GET /environments/{id}/history):
 * what changed and who changed it, never a secret's value. Best effort, as
 * every audit record is.
 */

import type { AuditAction, AuditActor } from "@/lib/audit/actions";
import { recordAudit } from "@/lib/audit/record";
import { getEnvironment } from "@/lib/db/environments";

export const PROJECT_RESOURCE = "environment";

export async function recordProjectChange(
  actor: Exclude<AuditActor, "system">,
  id: string,
  action: Extract<AuditAction, `project.${string}`>,
  details: Record<string, unknown> = {},
  known?: { orgId: string; name: string },
): Promise<void> {
  const project = known ?? (await getEnvironment(actor.id, id).catch(() => null));
  if (!project) return;
  await recordAudit({ orgId: project.orgId, actor, action, resource: { type: PROJECT_RESOURCE, id, label: project.name }, details });
}
