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

import { after } from "@/lib/observability/after";
import { isGitLabRef } from "@/lib/code-providers/repository";
import { requireGitLabToken } from "@/lib/db/gitlab-connections";
import { getPullRequestStatus } from "@/lib/code-providers/client";

import { stateOf, type PullRequestEvent, type PullRequestState } from "@/lib/session/pull-request-event";
import { recordPullRequestEventWith, type PullRequestChange } from "@/lib/session/pull-request-recording";
import { githubGet, repoToken } from "@/lib/slack/github";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { tellTrackersPullRequests } from "@/lib/trackers/write-back.deps";

/** A pull request a session changed state (or was opened): recorded
 *  (pull-request-recording.ts), on the real database, scoped to the orgs of
 *  the installation the event's webhook came from. */
export async function recordPullRequestEvent(event: PullRequestEvent, installationId: number): Promise<PullRequestChange[]> {
  return recordPullRequestEventWith(event, installationId, createSupabaseAdminClient());
}

/**
 * Check the open pull requests checked longest ago against GitHub, through
 * the org's GitHub App: those GitHub now calls closed or merged are recorded
 * so. Each is checked once a tick at most, `limit` a tick.
 */
export async function checkOpenPullRequests(
  limit = 25,
): Promise<Array<{ workspaceId: string; projectId: string; ownerId: string; from: PullRequestState; to: PullRequestState; number: number }>> {
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
  const changed: Array<{ workspaceId: string; projectId: string; ownerId: string; from: PullRequestState; to: PullRequestState; number: number }> = [];
  const now = new Date().toISOString();
  await Promise.all(
    open.map(async (pr) => {
      const project = projectById.get(pr.project_id);
      let state: PullRequestState | null = null;
      if (project && isGitLabRef(project.full_name)) {
        const token = await requireGitLabToken(pr.owner_id).catch(() => null);
        const status = token ? await getPullRequestStatus({ token, repoFullName: project.full_name, number: pr.github_number }).catch(() => null) : null;
        state = status?.state ?? null;
      } else {
        const token = project ? await repoToken(project.org_id, project.full_name).catch(() => null) : null;
        const found = token && project ? await githubGet<{ state?: string; merged?: boolean; merged_at?: string | null }>(token, `/repos/${project.full_name}/pulls/${pr.github_number}`) : null;
        state = found ? stateOf(found) : null;
      }
      const patch = state && state !== pr.state ? { state, state_at: now, checked_at: now } : { checked_at: now };
      const { data: updated, error: updateError } = await db
        .from("pull_requests")
        .update(patch)
        .eq("id", pr.id)
        .eq("state", "open")
        .select("id");
      if (updateError) throw updateError;
      // Recorded meanwhile (a webhook's delivery): it's that one's change.
      if (state && state !== pr.state && updated?.length) {
        changed.push({ workspaceId: pr.workspace_id, projectId: pr.project_id, ownerId: pr.owner_id, from: pr.state, to: state, number: pr.github_number });
      }
    }),
  );
  return changed;
}

/** What a session's page just read of its pull request, recorded when it
 *  differs from what was: the page asks GitHub on every visit. */
export async function notePullRequestState(pullRequest: { id: string; state?: PullRequestState }, state: PullRequestState): Promise<void> {
  if ((pullRequest.state ?? "open") === state) return;
  const now = new Date().toISOString();
  const { data, error } = await createSupabaseAdminClient()
    .from("pull_requests")
    .update({ state, state_at: now, checked_at: now })
    .eq("id", pullRequest.id)
    .select("workspace_id, project_id, github_number")
    .maybeSingle();
  if (error) console.error(`Pull request ${pullRequest.id}: couldn't record it ${state}`, error);
  // Recorded here, no webhook or tick will see it change: its tracker hears of it, after
  // the answer: a page's visit doesn't wait on Linear.
  if (data) {
    const change = { workspaceId: data.workspace_id, projectId: data.project_id, from: pullRequest.state ?? "open", to: state, number: data.github_number };
    after(() => tellTrackersPullRequests([change]));
  }
}
