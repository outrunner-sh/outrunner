/**
 * What a GitHub webhook says of one pull request, or of the head it's on,
 * read from its payload (activityOf), and the Runners it can be about
 * (runnersForWith) — the installation's own orgs' Runners only, the same
 * scoping as lib/session/pull-request-recording.ts: another org's project
 * renamed to collide with the repository must not receive its private
 * events. Split from lib/missions/pull-requests.ts, the database client
 * passed in, so this is testable in Node (that module imports the app's
 * routes and the Next-only supabase server client).
 */

import { toWorkspace } from "@/lib/db/mappers";
import { installationProjectsOf, repositoryIdOf } from "@/lib/db/installation-projects";
import { isRunnerBranch, runnersOwning } from "@/lib/missions/settle";
import type { Database } from "@/lib/supabase/database.types";
import type { Workspace } from "@/lib/runtime/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** What a webhook says of one pull request, or of the head it's on. */
export type PullRequestActivity = {
  /** The installation the event came from: only its orgs' Runners match. */
  installationId: number;
  repo: string;
  /** GitHub's own id of the repository: what projects match by. */
  repoId: number;
  /** The branches it's on: a check suite's, or the pull request's head. */
  headRefs: string[];
  /** The pull requests it names (a check run's, a review's). */
  numbers: number[];
  /** For a pull_request event: the pull request itself. */
  pr?: { number: number; url: string; title: string; headRef: string; baseRef: string; headSha: string; state: "open" | "merged" | "closed" };
};

export type GitHubPull = {
  number?: number;
  additions?: number;
  deletions?: number;
  html_url?: string;
  title?: string;
  state?: string;
  merged_at?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
};

/** A webhook's payload read as activity on pull requests, or null. An event
 *  without an installation can't be scoped to its orgs, nor one without a
 *  repository id to its projects, so either is no one's. */
export function activityOf(event: string | null, payload: Record<string, unknown>): PullRequestActivity | null {
  const repository = payload.repository as { full_name?: string; id?: unknown } | undefined;
  const repo = repository?.full_name;
  const installationId = (payload.installation as { id?: unknown } | undefined)?.id;
  const repoId = repositoryIdOf(payload);
  if (!repo || typeof installationId !== "number" || repoId === null) return null;
  const numbersOf = (list: unknown) =>
    Array.isArray(list) ? list.flatMap((p) => (typeof (p as { number?: unknown }).number === "number" ? [(p as { number: number }).number] : [])) : [];
  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_comment" || event === "pull_request_review_thread") {
    const pull = payload.pull_request as GitHubPull | undefined;
    if (!pull?.number || !pull.head?.ref) return null;
    return {
      installationId,
      repo,
      repoId,
      headRefs: [pull.head.ref],
      numbers: [pull.number],
      pr: {
        number: pull.number,
        url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
        title: pull.title ?? "",
        headRef: pull.head.ref,
        baseRef: pull.base?.ref ?? "",
        headSha: pull.head.sha ?? "",
        state: pull.state === "closed" ? (pull.merged_at ? "merged" : "closed") : "open",
      },
    };
  }
  if (event === "check_suite") {
    const suite = payload.check_suite as { head_branch?: string | null; pull_requests?: unknown } | undefined;
    return { installationId, repoId, repo, headRefs: suite?.head_branch ? [suite.head_branch] : [], numbers: numbersOf(suite?.pull_requests) };
  }
  if (event === "check_run") {
    const run = payload.check_run as { check_suite?: { head_branch?: string | null }; pull_requests?: unknown } | undefined;
    return { installationId, repoId, repo, headRefs: run?.check_suite?.head_branch ? [run.check_suite.head_branch] : [], numbers: numbersOf(run?.pull_requests) };
  }
  if (event === "status") {
    const branches = (payload.branches as { name?: string }[] | undefined) ?? [];
    return { installationId, repoId, repo, headRefs: branches.flatMap((b) => (b.name ? [b.name] : [])), numbers: [] };
  }
  return null;
}

/** What a Runner's session checked out, as project ids. */
function checkoutIds(checkouts: unknown): string[] {
  if (!Array.isArray(checkouts)) return [];
  return checkouts.flatMap((c) =>
    c && typeof c === "object" && typeof (c as { projectId?: unknown }).projectId === "string" ? [(c as { projectId: string }).projectId] : [],
  );
}

/**
 * Of `refs`, the ones a session of `projects` has as its own branch: any
 * session in their orgs, of one of them or with one among its several, any
 * status, Mission or not. Such a branch is that session's, never a Runner's
 * stacked work (runnersOwning).
 */
export async function sessionBranchesAmongWith(
  db: SupabaseClient<Database>,
  projects: readonly { id: string; org_id: string }[],
  refs: readonly string[],
): Promise<Set<string>> {
  if (refs.length === 0 || projects.length === 0) return new Set();
  const projectIds = new Set(projects.map((p) => p.id));
  const { data, error } = await db
    .from("workspaces")
    .select("project_id, checkouts, branch")
    .in("org_id", [...new Set(projects.map((p) => p.org_id))])
    .in("branch", [...new Set(refs)]);
  if (error) throw error;
  return new Set(
    (data ?? [])
      .filter((row) => projectIds.has(row.project_id) || checkoutIds(row.checkouts).some((id) => projectIds.has(id)))
      .map((row) => row.branch as string),
  );
}

/**
 * The projects of the GitHub repositories `repoIds` in the orgs `orgIds`:
 * matched by GitHub's own id, which no member can set, and never past the
 * orgs the caller is acting for (as lib/db/installation-projects.ts scopes a
 * webhook to its installation's), so another org's sessions never shape this
 * one's. Only their sessions' branch names are read from them
 * (sessionBranchesAmongWith), and only to keep a Runner off another
 * session's branch.
 */
export async function repositoryProjectsWith(
  db: SupabaseClient<Database>,
  repoIds: readonly number[],
  orgIds: readonly string[],
): Promise<{ id: string; org_id: string }[]> {
  if (repoIds.length === 0 || orgIds.length === 0) return [];
  const { data, error } = await db
    .from("projects")
    .select("id, org_id")
    .in("org_id", [...new Set(orgIds)])
    .in("github_repo_id", [...new Set(repoIds)]);
  if (error) throw error;
  return data ?? [];
}

/** Whether telling a Runner's stacked work apart needs the session branches:
 *  only when some ref is named after a Runner's branch without being it. */
export function namedAfterARunner(runners: readonly { branch: string }[], refs: readonly string[]): boolean {
  return runners.some((runner) => refs.some((ref) => ref !== runner.branch && isRunnerBranch(runner.branch, ref)));
}

/** The Runners an event can be about (runnerActivityWith). */
export async function runnersForWith(db: SupabaseClient<Database>, activity: PullRequestActivity): Promise<Workspace[]> {
  return (await runnerActivityWith(db, activity)).runners;
}

/**
 * The Runners an event in `activity.repo` can be about: Runners in its
 * orgs — the installation's own — that work in the repository (as their own,
 * or as one of a session of several), and of those, only the ones on a
 * branch it names or with a pull request of its on record. Check runs come
 * many a push: this keeps each to a query or two, whatever the number of
 * Runners. With them, the branches it names that are some session's own
 * (sessionBranchesAmongWith), for telling a Runner's stacked work apart.
 */
export async function runnerActivityWith(
  db: SupabaseClient<Database>,
  activity: PullRequestActivity,
): Promise<{ runners: Workspace[]; sessionBranches: Set<string> }> {
  const none = { runners: [], sessionBranches: new Set<string>() };
  const { projects } = await installationProjectsOf(db, activity.installationId, activity.repoId);
  if (projects.length === 0) return none;
  const projectIds = new Set(projects.map((p) => p.id));
  // What it takes to match, read narrow: whole rows only for the few that do.
  const { data, error: runnersError } = await db
    .from("workspaces")
    .select("id, project_id, checkouts, branch")
    .not("parent_mission_id", "is", null)
    .in("org_id", [...new Set(projects.map((p) => p.org_id))])
    .not("status", "in", "(destroyed,destroying)");
  if (runnersError) throw runnersError;
  const inRepo = (data ?? []).filter((row) => projectIds.has(row.project_id) || checkoutIds(row.checkouts).some((id) => projectIds.has(id)));
  if (inRepo.length === 0) return none;
  const refs = [...activity.headRefs, ...(activity.pr ? [activity.pr.headRef] : [])];
  // Across the repository's projects in the installation's orgs: the same
  // projects, matched by GitHub's id, that found these Runners.
  const sessionBranches = namedAfterARunner(inRepo, refs)
    ? await sessionBranchesAmongWith(db, projects, refs)
    : new Set<string>();
  const known = new Set<string>();
  if (activity.numbers.length > 0) {
    const { data: rows, error: rowsError } = await db
      .from("runner_pull_requests")
      .select("runner_id")
      .in(
        "runner_id",
        inRepo.map((r) => r.id),
      )
      .ilike("repo", activity.repo.replace(/[\\%_]/g, "\\$&"))
      .in("number", activity.numbers);
    if (rowsError) throw rowsError;
    for (const row of rows ?? []) known.add(row.runner_id);
  }
  const owned = new Set(refs.flatMap((ref) => runnersOwning(inRepo, ref, sessionBranches)).map((row) => row.id));
  const matched = inRepo.filter((row) => known.has(row.id) || owned.has(row.id)).map((row) => row.id);
  if (matched.length === 0) return none;
  const { data: rows, error: rowsError } = await db.from("workspaces").select("*").in("id", matched);
  if (rowsError) throw rowsError;
  return { runners: (rows ?? []).map(toWorkspace), sessionBranches };
}
