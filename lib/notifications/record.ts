/**
 * Recording notifications (session_notifications) as the server sees news:
 * from the watch's reads (notifyActivity), GitHub's pull request changes
 * (notifyPullRequests), and sessions that failed (notifyFailures, the tick's).
 * Each is recorded once by its event key, so a watch and a tick that both see
 * it tell the user once. Delivery is lib/notifications/deliver.ts's, and the
 * browser's (hooks/use-notifications.ts).
 */

import { toWorkspace } from "@/lib/db/mappers";
import { workspaceLabel } from "@/lib/nav/session-title";
import { activityNews, errorNews, pullRequestNews, type NotificationDraft } from "@/lib/notifications/events";
import type { ActivityChange } from "@/lib/session/watch";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** Record `drafts`; those recorded before are skipped. How many were new. */
export async function recordNotifications(drafts: NotificationDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const { data, error } = await db()
    .from("session_notifications")
    .upsert(
      drafts.map((d) => ({
        user_id: d.userId,
        workspace_id: d.workspaceId,
        kind: d.kind,
        event_key: d.eventKey,
        title: d.title,
        body: d.body,
      })),
      { onConflict: "user_id,workspace_id,kind,event_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/** Sessions' names, by id, as their owners see them. */
async function titles(workspaceIds: string[]): Promise<Map<string, string>> {
  if (workspaceIds.length === 0) return new Map();
  const { data, error } = await db().from("workspaces").select("*").in("id", [...new Set(workspaceIds)]);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id, workspaceLabel(toWorkspace(row))]));
}

/** A watch's read that changed something: its news, recorded. */
export async function notifyActivity(change: ActivityChange, now: number = Date.now()): Promise<void> {
  const title = (await titles([change.workspaceId])).get(change.workspaceId);
  if (!title) return;
  await recordNotifications(
    activityNews(change, { userId: change.ownerId, workspaceId: change.workspaceId, title }, now),
  );
}

/** Pull requests that opened or merged: their news, recorded. */
export async function notifyPullRequests(
  changes: Array<{ workspaceId: string; ownerId: string; from: "open" | "closed" | "merged" | null; to: "open" | "closed" | "merged"; number: number }>,
): Promise<void> {
  if (changes.length === 0) return;
  const named = await titles(changes.map((c) => c.workspaceId));
  await recordNotifications(
    changes.flatMap((c) => {
      const title = named.get(c.workspaceId);
      return title ? pullRequestNews(c, { userId: c.ownerId, workspaceId: c.workspaceId, title }) : [];
    }),
  );
}

/** How far back the tick looks for sessions that failed: a little over two
 *  ticks, so none is missed between them. */
const FAILED_WITHIN_MS = 10 * 60_000;

/** Sessions that failed lately: told once each failure. */
export async function notifyFailures(now: number = Date.now()): Promise<number> {
  const { data, error } = await db()
    .from("workspaces")
    .select("*")
    .eq("status", "failed")
    .eq("background", false)
    .gt("updated_at", new Date(now - FAILED_WITHIN_MS).toISOString())
    .limit(100);
  if (error) throw error;
  return recordNotifications(
    (data ?? []).map((row) => {
      const workspace = toWorkspace(row);
      return errorNews({
        userId: workspace.ownerId,
        workspaceId: workspace.id,
        title: workspaceLabel(workspace),
        failedAt: workspace.updatedAt,
        message: workspace.errorMessage,
      });
    }),
  );
}
