/**
 * A session's pull request as GitHub last said: open, closed or merged. Kept
 * on its pull_requests row, which is what "In review" and "Done" are worked
 * out from (lib/session/standing.ts). Told by the GitHub App's webhook as it
 * happens, and checked by the sessions tick for what the webhook can't tell
 * (a repository the App isn't on, a delivery lost).
 *
 * The webhook also records a pull request the session's agent opened itself,
 * which until now was only found when its page asked.
 */

import { stateOf, type PullRequestEvent, type PullRequestState } from "@/lib/session/pull-request-event";
import { githubGet, repoToken } from "@/lib/slack/github";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A pull request a session changed state (or was opened): changes recorded,
 *  by session. The sessions it's on are found by repository and branch, as
 *  the Slack agent's announcement finds them. */
export async function recordPullRequestEvent(event: PullRequestEvent): Promise<Array<{ workspaceId: string; ownerId: string; from: PullRequestState | null }>> {
  const db = createSupabaseAdminClient();
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, org_id")
    .ilike("full_name", event.repoFullName.replace(/[\\%_]/g, "\\$&"));
  if (projectsError) throw projectsError;
  if (!projects?.length) return [];
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
  const changed: Array<{ workspaceId: string; ownerId: string; from: PullRequestState | null }> = [];
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
      if (!error) changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: null });
      continue;
    }
    if (existing.github_number !== event.number) {
      // A new pull request from the branch after its last one closed
      // unmerged: it's the session's now (one a repository, so it replaces
      // the closed one). Otherwise it's another of the branch's, not this.
      if (existing.state !== "closed" || event.state !== "open") continue;
      const { error } = await db
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
        .eq("state", "closed");
      if (error) throw error;
      changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: null });
      continue;
    }
    if (existing.state === event.state) continue;
    const { error } = await db
      .from("pull_requests")
      .update({ state: event.state, state_at: now, checked_at: now, title: event.title })
      .eq("id", existing.id);
    if (error) throw error;
    changed.push({ workspaceId: session.id, ownerId: session.owner_id, from: existing.state });
  }
  return changed;
}

function checkoutIds(checkouts: unknown): string[] {
  if (!Array.isArray(checkouts)) return [];
  return checkouts.flatMap((c) => (c && typeof c === "object" && typeof (c as { projectId?: unknown }).projectId === "string" ? [(c as { projectId: string }).projectId] : []));
}

/**
 * Check the open pull requests checked longest ago against GitHub, through
 * the org's GitHub App: those GitHub now calls closed or merged are recorded
 * so. Each is checked once a tick at most, `limit` a tick.
 */
export async function checkOpenPullRequests(limit = 25): Promise<Array<{ workspaceId: string; ownerId: string; from: PullRequestState; to: PullRequestState }>> {
  const db = createSupabaseAdminClient();
  const { data: open, error } = await db
    .from("pull_requests")
    .select("id, workspace_id, owner_id, project_id, github_number, state")
    .eq("state", "open")
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  if (!open?.length) return [];
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, org_id, full_name")
    .in("id", [...new Set(open.map((p) => p.project_id))]);
  if (projectsError) throw projectsError;
  const projectById = new Map((projects ?? []).map((p) => [p.id, p]));
  const changed: Array<{ workspaceId: string; ownerId: string; from: PullRequestState; to: PullRequestState }> = [];
  const now = new Date().toISOString();
  await Promise.all(
    open.map(async (pr) => {
      const project = projectById.get(pr.project_id);
      const token = project ? await repoToken(project.org_id, project.full_name).catch(() => null) : null;
      const found = token && project ? await githubGet<{ state?: string; merged?: boolean; merged_at?: string | null }>(token, `/repos/${project.full_name}/pulls/${pr.github_number}`) : null;
      const state = found ? stateOf(found) : null;
      const patch = state && state !== pr.state ? { state, state_at: now, checked_at: now } : { checked_at: now };
      const { error: updateError } = await db.from("pull_requests").update(patch).eq("id", pr.id).eq("state", "open");
      if (updateError) throw updateError;
      if (state && state !== pr.state) changed.push({ workspaceId: pr.workspace_id, ownerId: pr.owner_id, from: pr.state, to: state });
    }),
  );
  return changed;
}

/** What a session's page just read of its pull request, recorded when it
 *  differs from what was: the page asks GitHub on every visit. */
export async function notePullRequestState(pullRequest: { id: string; state?: PullRequestState }, state: PullRequestState): Promise<void> {
  if ((pullRequest.state ?? "open") === state) return;
  const now = new Date().toISOString();
  const { error } = await createSupabaseAdminClient()
    .from("pull_requests")
    .update({ state, state_at: now, checked_at: now })
    .eq("id", pullRequest.id);
  if (error) console.error(`Pull request ${pullRequest.id}: couldn't record it ${state}`, error);
}
