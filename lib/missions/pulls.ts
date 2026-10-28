/**
 * A Runner's pull requests and where they stand, read as its owner works on
 * GitHub (lib/github/identity.ts): the one on record for each of its
 * repositories, else the one its agent opened from its branch, recorded once
 * found, as the session page's pull request route does.
 */

import { toWorkspacePullRequest } from "@/lib/db/mappers";
import { findPullRequest, getPullRequestStatus, type PullRequestStatus } from "@/lib/github/client";
import { requireGitToken } from "@/lib/github/identity.deps";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { pullRequestVerdict, type PullRequestVerdict } from "@/lib/session/pull-request-status";
import { sessionRepos } from "@/lib/session/session-repos";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type RunnerPullRequest = {
  repo: string;
  number: number;
  url: string;
  title: string;
  /** Null when GitHub couldn't be asked. */
  status: PullRequestStatus | null;
  verdict: PullRequestVerdict | null;
};

/** The Runner's pull requests, one a repository at most; none yet is []. */
export async function runnerPullRequests(runner: Workspace): Promise<RunnerPullRequest[]> {
  const db = createSupabaseAdminClient();
  const repos = sessionRepos(runner);
  const { data: projects, error } = await db
    .from("projects")
    .select("id, org_id, full_name")
    .in(
      "id",
      repos.map((r) => r.projectId),
    );
  if (error) throw error;
  const { data: recorded, error: recordedError } = await db.from("pull_requests").select("*").eq("workspace_id", runner.id);
  if (recordedError) throw recordedError;
  const found: RunnerPullRequest[] = [];
  for (const repo of repos) {
    const project = projects?.find((p) => p.id === repo.projectId);
    if (!project) continue;
    const fullName = repo.fullName ?? project.full_name;
    let token: string;
    try {
      token = await requireGitToken(runner.ownerId, { orgId: project.org_id, fullName });
    } catch {
      continue;
    }
    let pr: WorkspacePullRequest | null = null;
    const row = recorded?.find((r) => r.project_id === repo.projectId);
    if (row) pr = toWorkspacePullRequest(row);
    else {
      const ref = await findPullRequest({ token, repoFullName: fullName, headBranch: runner.branch }).catch(() => null);
      if (!ref) continue;
      const { data: inserted } = await db
        .from("pull_requests")
        .insert({
          owner_id: runner.ownerId,
          workspace_id: runner.id,
          project_id: repo.projectId,
          github_number: ref.number,
          url: ref.url,
          title: ref.title,
          base_branch: ref.baseBranch,
          head_branch: runner.branch,
        })
        .select("*")
        .maybeSingle();
      // Recorded by another read at once: theirs is the same pull request.
      pr = inserted
        ? toWorkspacePullRequest(inserted)
        : { id: "", workspaceId: runner.id, projectId: repo.projectId, number: ref.number, url: ref.url, title: ref.title, baseBranch: ref.baseBranch, headBranch: runner.branch, createdAt: "" };
    }
    const status = await getPullRequestStatus({ token, repoFullName: fullName, number: pr.number }).catch(() => null);
    found.push({
      repo: fullName,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      status,
      verdict: status ? pullRequestVerdict(status) : null,
    });
  }
  return found;
}

