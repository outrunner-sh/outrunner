import { gitLabPath } from "@/lib/code-providers/repository";
import type { BranchList, MergeMethod, PullRequestDetails, PullRequestStatus, WorkspacePullRequestRef } from "@/lib/github/client";
import { GitLabError, gitLabJson, gitLabRequest } from "@/lib/gitlab/client";

function projectPath(ref: string): string {
  return `/projects/${encodeURIComponent(gitLabPath(ref))}`;
}

type MergeRequest = {
  iid: number; web_url: string; title: string; target_branch: string; source_branch?: string;
  source_project_id: number; target_project_id: number;
  state: "opened" | "closed" | "merged" | "locked";
  draft?: boolean; work_in_progress?: boolean; sha: string;
  detailed_merge_status?: string; head_pipeline?: { status: string; web_url?: string } | null;
};

export async function findMergeRequest(input: { token: string; repoFullName: string; headBranch: string }): Promise<WorkspacePullRequestRef | null> {
  const query = new URLSearchParams({ source_branch: input.headBranch, state: "all", order_by: "created_at", sort: "desc", per_page: "100" });
  const response = await gitLabRequest(input.token, `${projectPath(input.repoFullName)}/merge_requests?${query}`);
  if (response.status === 404) throw new GitLabError("Your GitLab account cannot access this repository.", 403);
  const list = await gitLabJson<MergeRequest[]>(response);
  if (!Array.isArray(list)) throw new GitLabError("GitLab returned an invalid merge request list.");
  // A fork can use the same branch name. Sessions push into the origin
  // project, so another project's merge request must never be linked to it.
  const mr = list.find((item) => Number.isSafeInteger(item.source_project_id) && item.source_project_id === item.target_project_id);
  if (!mr) return null;
  return { number: mr.iid, url: mr.web_url, title: mr.title, baseBranch: mr.target_branch };
}

export async function branchKnownOnGitLab(input: { token: string; repoFullName: string; branch: string }): Promise<boolean> {
  if (await branchOnGitLab(input)) return true;
  return (await findMergeRequest({ ...input, headBranch: input.branch })) !== null;
}

/** Whether `branch` is a branch in the repository now. */
export async function branchOnGitLab(input: { token: string; repoFullName: string; branch: string }): Promise<boolean> {
  const response = await gitLabRequest(input.token, `${projectPath(input.repoFullName)}/repository/branches/${encodeURIComponent(input.branch)}`);
  return response.ok;
}

/** The repository's branches whose name holds `query` (every one for none),
 *  the first `first` of them by name. */
export async function listGitLabBranches(input: { token: string; repoFullName: string; query: string; first: number }): Promise<BranchList> {
  const params = new URLSearchParams({ per_page: String(input.first), ...(input.query && { search: input.query }) });
  const response = await gitLabRequest(input.token, `${projectPath(input.repoFullName)}/repository/branches?${params}`);
  if (response.status === 404) throw new GitLabError("Your GitLab account cannot access this repository.", 403);
  const list = await gitLabJson<{ name?: unknown }[]>(response);
  if (!Array.isArray(list)) throw new GitLabError("GitLab returned an invalid branch list.");
  const branches = list.map((b) => b.name).filter((name): name is string => typeof name === "string");
  // GitLab leaves out its count past 10,000.
  return { branches, total: Number(response.headers.get("x-total")) || branches.length };
}

export async function mergeRequestStatus(input: { token: string; repoFullName: string; number: number }): Promise<{ status: PullRequestStatus; details: PullRequestDetails }> {
  const response = await gitLabRequest(input.token, `${projectPath(input.repoFullName)}/merge_requests/${input.number}`);
  if (response.status === 404) throw new GitLabError("This GitLab merge request could not be found.", 404);
  const mr = await gitLabJson<MergeRequest>(response);
  if (!mr.sha || !["opened", "closed", "merged", "locked"].includes(mr.state)) throw new GitLabError("GitLab returned an invalid merge request.");
  const checks = { passing: 0, failing: 0, pending: 0 };
  const pipeline = mr.head_pipeline;
  if (pipeline) {
    if (["success", "skipped"].includes(pipeline.status)) checks.passing++;
    else if (["failed", "canceled"].includes(pipeline.status)) checks.failing++;
    else checks.pending++;
  }
  const mergeStates: Record<string, string> = { mergeable: "clean", conflict: "dirty", need_rebase: "behind", draft_status: "draft", checking: "unknown", unchecked: "unknown" };
  return {
    status: {
      state: mr.state === "opened" || mr.state === "locked" ? "open" : mr.state,
      draft: mr.draft === true || mr.work_in_progress === true,
      mergeableState: mergeStates[mr.detailed_merge_status ?? ""] ?? "blocked", headSha: mr.sha, checks,
    },
    details: {
      title: mr.title, baseRef: mr.target_branch, headRef: mr.source_branch ?? null,
      fromFork: mr.source_project_id !== mr.target_project_id, additions: null, deletions: null,
      checkRuns: pipeline ? [{ name: "GitLab pipeline", status: checks.pending ? "in_progress" : "completed", conclusion: checks.pending ? null : checks.failing ? "failure" : "success", url: pipeline.web_url ?? null }] : [],
    },
  };
}

export async function mergeMergeRequest(input: { token: string; repoFullName: string; number: number; headSha: string; methods?: readonly MergeMethod[] | null }): Promise<void> {
  const response = await gitLabRequest(input.token, `${projectPath(input.repoFullName)}/merge_requests/${input.number}/merge`, {
    method: "PUT", body: JSON.stringify({ sha: input.headSha }),
  });
  if (response.status === 404) throw new GitLabError("This GitLab merge request could not be found.", 404);
  const mr = await gitLabJson<MergeRequest>(response);
  if (mr.state !== "merged") throw new GitLabError("GitLab has not merged this request. Check its pipeline and approval requirements.", 409);
}
