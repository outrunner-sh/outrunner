/**
 * Recording what happens to an org (lib/audit/actions.ts) in its audit log.
 * Best effort: a change that went through is never failed by its record, so
 * a failure here is logged and the caller carries on.
 */

import { type AuditAction, type AuditActor, actorLabel } from "@/lib/audit/actions";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type AuditResource = { type: string; id?: string | null; label?: string | null };

export async function recordAudit(event: {
  orgId: string;
  actor: AuditActor;
  action: AuditAction;
  resource?: AuditResource;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await createSupabaseAdminClient()
      .from("audit_events")
      .insert({
        org_id: event.orgId,
        actor_type: event.actor === "system" ? "system" : "user",
        actor_id: event.actor === "system" ? null : event.actor.id,
        actor_label: actorLabel(event.actor),
        action: event.action,
        resource_type: event.resource?.type ?? null,
        resource_id: event.resource?.id ?? null,
        resource_label: event.resource?.label?.slice(0, 300) ?? null,
        details: (event.details ?? {}) as never,
      });
    if (error) throw error;
  } catch (error) {
    console.error(`Audit: couldn't record ${event.action} for org ${event.orgId}`, error);
  }
}
