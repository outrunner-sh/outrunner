/**
 * Reading an org's audit log (20261101115000_audit_events.sql), newest
 * first, a page at a time. The server's alone: the route has checked the
 * caller is the org's admin.
 */

import type { AuditEvent } from "@/lib/audit/actions";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const AUDIT_PAGE = 50;

/** The org's events older than `before` (an event's id; none: the newest),
 *  up to a page, and whether there are more. */
export async function listAuditEvents(
  orgId: string,
  before?: number,
): Promise<{ events: AuditEvent[]; more: boolean }> {
  let query = createSupabaseAdminClient()
    .from("audit_events")
    .select("id, actor_type, actor_id, actor_label, action, resource_type, resource_id, resource_label, details, created_at")
    .eq("org_id", orgId)
    .order("id", { ascending: false })
    .limit(AUDIT_PAGE + 1);
  if (before) query = query.lt("id", before);
  const { data, error } = await query;
  if (error && probeStatus(error) === "missing") return { events: [], more: false };
  if (error) throw error;
  const rows = data ?? [];
  return {
    more: rows.length > AUDIT_PAGE,
    events: rows.slice(0, AUDIT_PAGE).map((row) => ({
      id: Number(row.id),
      actorType: row.actor_type as "user" | "system",
      actorId: row.actor_id,
      actorLabel: row.actor_label,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      resourceLabel: row.resource_label,
      details: (row.details ?? {}) as Record<string, unknown>,
      createdAt: row.created_at,
    })),
  };
}
