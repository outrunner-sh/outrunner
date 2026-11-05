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
import { installationProjectsOf } from "@/lib/db/installation-projects";
import { isRunnerBranch } from "@/lib/missions/settle";
import type { Database } from "@/lib/supabase/database.types";
import type { Workspace } from "@/lib/runtime/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** What a webhook says of one pull request, or of the head it's on. */
export type PullRequestActivity = {
  /** The installation the event came from: only its orgs' Runners match. */
  installationId: number;
  repo: string;
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
 *  without an installation can't be scoped to its orgs, so it's no one's. */
export function activityOf(event: string | null, payload: Record<string, unknown>): PullRequestActivity | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  const installationId = (payload.installation as { id?: unknown } | undefined)?.id;
  if (!repo || typeof installationId !== "number") return null;
  const numbersOf = (list: unknown) =>
    Array.isArray(list) ? list.flatMap((p) => (typeof (p as { number?: unknown }).number === "number" ? [(p as { number: number }).number] : [])) : [];
  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_comment" || event === "pull_request_review_thread") {
    const pull = payload.pull_request as GitHubPull | undefined;
    if (!pull?.number || !pull.head?.ref) return null;
    return {
      installationId,
      repo,
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
    return { installationId, repo, headRefs: suite?.head_branch ? [suite.head_branch] : [], numbers: numbersOf(suite?.pull_requests) };
  }
  if (event === "check_run") {
    const run = payload.check_run as { check_suite?: { head_branch?: string | null }; pull_requests?: unknown } | undefined;
    return { installationId, repo, headRefs: run?.check_suite?.head_branch ? [run.check_suite.head_branch] : [], numbers: numbersOf(run?.pull_requests) };
  }
  if (event === "status") {
    const branches = (payload.branches as { name?: string }[] | undefined) ?? [];
    return { installationId, repo, headRefs: branches.flatMap((b) => (b.name ? [b.name] : [])), numbers: [] };
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
 * The Runners an event in `activity.repo` can be about: Runners in its
 * orgs — the installation's own — that work in the repository (as their own,
 * or as one of a session of several), and of those, only the ones on a
 * branch it names or with a pull request of its on record. Check runs come
 * many a push: this keeps each to a query or two, whatever the number of
 * Runners.
 */
export async function runnersForWith(db: SupabaseClient<Database>, activity: PullRequestActivity): Promise<Workspace[]> {
  const projects = await installationProjectsOf(db, activity.installationId, activity.repo);
  if (projects.length === 0) return [];
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
  if (inRepo.length === 0) return [];
  const refs = [...activity.headRefs, ...(activity.pr ? [activity.pr.headRef] : [])];
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
  const matched = inRepo.filter((row) => known.has(row.id) || refs.some((ref) => isRunnerBranch(row.branch, ref))).map((row) => row.id);
  if (matched.length === 0) return [];
  const { data: rows, error: rowsError } = await db.from("workspaces").select("*").in("id", matched);
  if (rowsError) throw rowsError;
  return (rows ?? []).map(toWorkspace);
}
