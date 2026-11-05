/**
 * A pull request event recorded on its sessions' pull_requests rows: the
 * webhook's half of lib/session/pull-request-state.ts, split out so the
 * database it works on is passed in and the logic is testable in Node. The
 * state itself (lib/session/pull-request-event.ts reads it) is GitHub's word
 * of a session's pull request: open, closed or merged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { installationProjectsOf } from "@/lib/db/installation-projects";
import type { PullRequestEvent, PullRequestState } from "@/lib/session/pull-request-event";
import type { Database } from "@/lib/supabase/database.types";

/** A pull request a session changed state (or was opened), recorded: told of
 *  below (notifyPullRequests), by session. */
export type PullRequestChange = { workspaceId: string; ownerId: string; from: PullRequestState | null; to: PullRequestState; number: number };

/** A pull request a session changed state (or was opened): changes recorded,
 *  by session. The sessions it's on are found by repository and branch, as
 *  the Slack agent's announcement finds them — but only among the orgs that
 *  own the installation the event came from (installation-projects.ts), and
 *  by GitHub's repository id, never the full name: a project's full name
 *  is its org's members' to choose, and another org's could be renamed to
 *  collide with this repository's, which must not receive its private
 *  events. */
export async function recordPullRequestEventWith(
  event: PullRequestEvent,
  installationId: number,
  db: SupabaseClient<Database>,
): Promise<PullRequestChange[]> {
  const { projects } = await installationProjectsOf(db, installationId, event.repoId);
  if (!projects.length) return [];
  const projectIds = projects.map((p) => p.id);
  // The repository's own sessions on the branch, and the sessions of several
  // repositories in its orgs: never every org's sessions on a branch as
  // common as `main`.
  const [own, several] = await Promise.all([
    db.from("workspaces").select("id, owner_id, project_id, checkouts").eq("branch", event.headRef).neq("status", "destroyed").in("project_id", projectIds),
    db
      .from("workspaces")
      .select("id, owner_id, project_id, checkouts")
      .eq("branch", event.headRef)
      .neq("status", "destroyed")
      .in("org_id", [...new Set(projects.map((p) => p.org_id))])
      .not("checkouts", "is", null),
  ]);
  if (own.error) throw own.error;
  if (several.error) throw several.error;
  const sessions = [...new Map([...(own.data ?? []), ...(several.data ?? [])].map((s) => [s.id, s])).values()];
  const changed: PullRequestChange[] = [];
  const now = new Date().toISOString();
  for (const session of sessions) {
    // The repository it's in: the session's own, or one of a session of several.
    const projectId = projectIds.find((id) => id === session.project_id || checkoutIds(session.checkouts).includes(id));
    if (!projectId) continue;
    const { data: existing, error: existingError } = await db
      .from("pull_requests")
      .select("id, state, github_number")
      .eq("workspace_id", session.id)
      .eq("project_id", projectId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      const { error } = await db.from("pull_requests").insert({
        owner_id: session.owner_id,
        workspace_id: session.id,
        project_id: projectId,
        github_number: event.number,
        url: event.url,
        title: event.title,
        base_branch: event.baseRef,
        head_branch: event.headRef,
        state: event.state,
        state_at: now,
        checked_at: now,
      });
      // Recorded meanwhile by the session's page: its state is the next check's.
      if (error && error.code !== "23505") throw error;
      if (!error) changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: null, to: event.state, number: event.number });
      continue;
    }
    if (existing.github_number !== event.number) {
      // A new pull request from the branch after its last one closed
      // unmerged: it's the session's now (one a repository, so it replaces
      // the closed one). Otherwise it's another of the branch's, not this.
      if (existing.state !== "closed" || event.state !== "open") continue;
      const { data: replaced, error } = await db
        .from("pull_requests")
        .update({
          github_number: event.number,
          url: event.url,
          title: event.title,
          base_branch: event.baseRef,
          state: event.state,
          state_at: now,
          checked_at: now,
        })
        .eq("id", existing.id)
        .eq("state", "closed")
        .select("id");
      if (error) throw error;
      // Reopened meanwhile (a page's read, another delivery): nothing changed
      // here. A new pull request, not the closed one again: told as its first
      // opening (from nothing), not as a reopen.
      if (replaced?.length) {
        changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: null, to: event.state, number: event.number });
      }
      continue;
    }
    if (existing.state === event.state) continue;
    const { error } = await db
      .from("pull_requests")
      .update({ state: event.state, state_at: now, checked_at: now, title: event.title })
      .eq("id", existing.id);
    if (error) throw error;
    changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: existing.state, to: event.state, number: event.number });
  }
  return changed;
}

function checkoutIds(checkouts: unknown): string[] {
  if (!Array.isArray(checkouts)) return [];
  return checkouts.flatMap((c) => (c && typeof c === "object" && typeof (c as { projectId?: unknown }).projectId === "string" ? [(c as { projectId: string }).projectId] : []));
}
