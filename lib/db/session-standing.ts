/**
 * Where the user's sessions stand (lib/session/standing.ts), read for the
 * sidebar and the sessions list: what the server's watch recorded of each
 * agent, the user's own marks, and each pull request's state. Under the
 * user's own client: they read only their own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import {
  isStanding,
  sessionStanding,
  type SessionActivity,
  type SessionMark,
  type SessionStanding,
  type Standing,
} from "@/lib/session/standing";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function readStandings(
  /** Whose marks; null for none (another member's sessions, read as the
   *  server). */
  userId: string | null,
  workspaces: Workspace[],
  pullRequests: Record<string, WorkspacePullRequest>,
  now: number = Date.now(),
  /** The user's own client unless given (the server's, for sessions the
   *  user may see but RLS keeps to their owners). */
  client?: SupabaseClient<Database>,
): Promise<Record<string, SessionStanding>> {
  if (workspaces.length === 0) return {};
  const ids = workspaces.map((w) => w.id);
  const supabase = client ?? (await createSupabaseServerClient());
  const [activity, marks] = await Promise.all([
    supabase.from("session_activity").select("*").in("workspace_id", ids),
    userId
      ? supabase.from("session_marks").select("*").eq("user_id", userId).in("workspace_id", ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  // A deploy ahead of its migration reads nothing here: every session is
  // placed from its own row and pull request alone.
  if (activity.error) console.error("Standings: couldn't read session activity", activity.error);
  if (marks.error) console.error("Standings: couldn't read session marks", marks.error);
  const activityBy = new Map<string, SessionActivity>(
    (activity.data ?? []).map((row) => [
      row.workspace_id,
      {
        turn: row.turn,
        turnStartedAt: row.turn_started_at,
        waiting: row.waiting,
        waitingSince: row.waiting_since,
        repliedAt: row.replied_at,
        replyPreview: row.reply_preview,
        eventAt: row.event_at,
        createdAt: row.created_at,
      },
    ]),
  );
  const markBy = new Map<string, SessionMark>(
    (marks.data ?? []).map((row) => [
      row.workspace_id,
      {
        pinnedAt: row.pinned_at,
        movedTo: isStanding(row.moved_to) ? row.moved_to : null,
        movedAt: row.moved_at,
        seenAt: row.seen_at,
      },
    ]),
  );
  const standings: Record<string, SessionStanding> = {};
  for (const workspace of workspaces) {
    const pr = pullRequests[workspace.id];
    standings[workspace.id] = sessionStanding({
      workspace,
      activity: activityBy.get(workspace.id) ?? null,
      pullRequest: pr ? { state: pr.state ?? "open", stateAt: pr.stateAt ?? null } : null,
      mark: markBy.get(workspace.id) ?? null,
      now,
    });
  }
  return standings;
}

/** A change to the user's marks on a session. */
export type MarkChange = { pinned?: boolean; movedTo?: Standing | null; seen?: boolean };

/** Record `change` to the user's marks on `workspaceId` (one they can read:
 *  the caller checked). */
export async function updateMark(userId: string, workspaceId: string, change: MarkChange): Promise<void> {
  const now = new Date().toISOString();
  const patch = {
    ...(change.pinned !== undefined && { pinned_at: change.pinned ? now : null }),
    ...(change.movedTo !== undefined && { moved_to: change.movedTo, moved_at: change.movedTo ? now : null }),
    ...(change.seen && { seen_at: now }),
    updated_at: now,
  };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("session_marks")
    .upsert({ user_id: userId, workspace_id: workspaceId, ...patch }, { onConflict: "user_id,workspace_id" });
  if (error) throw error;
}
