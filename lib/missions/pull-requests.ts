/**
 * A Runner's pull requests, followed to the end (docs/missions.md): found as
 * GitHub announces them (app/api/github/webhook) or as the tick looks, each
 * one's CI and review activity noted, and once that has been quiet a while,
 * decided from what GitHub says of it then (lib/missions/settle.ts): ready,
 * or needing attention. Merged or closed, its Mission hears so, and once all
 * of a Runner's are, the Runner is archived.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { getPullRequestStatus } from "@/lib/github/client";
import { optionalGitToken } from "@/lib/github/identity.deps";
import { githubGet } from "@/lib/github/rest";
import { sessionWorking } from "@/lib/missions/box";
import { eventKey, type PullRequestRef } from "@/lib/missions/events";
import { isLiveRunner } from "@/lib/missions/rules";
import { allPullRequestsDone, isNews, isRunnerBranch, reviewState, settle } from "@/lib/missions/settle";
import { queuedCounts, sessionById } from "@/lib/missions/store";
import { readyNotification } from "@/lib/missions/events";
import { recordMissionEvent } from "@/lib/missions/watch.deps";
import { recordNotifications } from "@/lib/notifications/record";
import { repoToken } from "@/lib/slack/github";
import type { Workspace } from "@/lib/runtime/types";
import { asBrowser } from "@/lib/slack/research";
import { actAsUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** What a webhook says of one pull request, or of the head it's on. */
export type PullRequestActivity = {
  repo: string;
  /** The branches it's on: a check suite's, or the pull request's head. */
  headRefs: string[];
  /** The pull requests it names (a check run's, a review's). */
  numbers: number[];
  /** For a pull_request event: the pull request itself. */
  pr?: { number: number; url: string; title: string; headRef: string; baseRef: string; headSha: string; state: "open" | "merged" | "closed" };
};

type GitHubPull = {
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

/** A webhook's payload read as activity on pull requests, or null. */
export function activityOf(event: string | null, payload: Record<string, unknown>): PullRequestActivity | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  if (!repo) return null;
  const numbersOf = (list: unknown) =>
    Array.isArray(list) ? list.flatMap((p) => (typeof (p as { number?: unknown }).number === "number" ? [(p as { number: number }).number] : [])) : [];
  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_comment" || event === "pull_request_review_thread") {
    const pull = payload.pull_request as GitHubPull | undefined;
    if (!pull?.number || !pull.head?.ref) return null;
    return {
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
    return { repo, headRefs: suite?.head_branch ? [suite.head_branch] : [], numbers: numbersOf(suite?.pull_requests) };
  }
  if (event === "check_run") {
    const run = payload.check_run as { check_suite?: { head_branch?: string | null }; pull_requests?: unknown } | undefined;
    return { repo, headRefs: run?.check_suite?.head_branch ? [run.check_suite.head_branch] : [], numbers: numbersOf(run?.pull_requests) };
  }
  if (event === "status") {
    const branches = (payload.branches as { name?: string }[] | undefined) ?? [];
    return { repo, headRefs: branches.flatMap((b) => (b.name ? [b.name] : [])), numbers: [] };
  }
  return null;
}

/** The live Runners working in `repo`. */
async function runnersIn(repo: string): Promise<Workspace[]> {
  const { data: projects, error } = await db().from("projects").select("id").ilike("full_name", repo.replace(/[\\%_]/g, "\\$&"));
  if (error) throw error;
  if (!projects?.length) return [];
  const { data, error: runnersError } = await db()
    .from("workspaces")
    .select("id")
    .not("parent_mission_id", "is", null)
    .in(
      "project_id",
      projects.map((p) => p.id),
    )
    .not("status", "in", "(destroyed,destroying)");
  if (runnersError) throw runnersError;
  const runners = await Promise.all((data ?? []).map((r) => sessionById(r.id)));
  return runners.filter((r): r is Workspace => r !== null);
}

/** Note what a webhook said: a new pull request of a Runner's recorded, and
 *  activity on one starting (or extending) its stretch. The Runners whose
 *  pull requests it touched. */
export async function notePullRequestActivity(activity: PullRequestActivity): Promise<string[]> {
  const touched = new Set<string>();
  const runners = await runnersIn(activity.repo);
  const now = new Date().toISOString();
  for (const runner of runners) {
    const pr = activity.pr;
    if (pr && isRunnerBranch(runner.branch, pr.headRef)) {
      const { error } = await db()
        .from("runner_pull_requests")
        .upsert(
          {
            runner_id: runner.id,
            repo: activity.repo,
            number: pr.number,
            url: pr.url,
            title: pr.title,
            head_ref: pr.headRef,
            base_ref: pr.baseRef || null,
            ...(pr.headSha && { head_sha: pr.headSha }),
          },
          { onConflict: "runner_id,repo,number", ignoreDuplicates: false },
        );
      if (error) throw error;
    }
    const { data: rows, error } = await db()
      .from("runner_pull_requests")
      .select("number, head_ref, verdict")
      .eq("runner_id", runner.id)
      .ilike("repo", activity.repo.replace(/[\\%_]/g, "\\$&"))
      .eq("state", "open");
    if (error) throw error;
    for (const row of rows ?? []) {
      if (!activity.numbers.includes(row.number) && !activity.headRefs.includes(row.head_ref)) continue;
      // A decided one starts a new stretch; an undecided one's goes on.
      await db()
        .from("runner_pull_requests")
        .update({
          last_activity_at: now,
          verdict: null,
          verdict_reason: null,
          ...(row.verdict !== null && { first_activity_at: now }),
        })
        .eq("runner_id", runner.id)
        .eq("number", row.number)
        .ilike("repo", activity.repo.replace(/[\\%_]/g, "\\$&"));
      touched.add(runner.id);
    }
  }
  return [...touched];
}

/** A token to read the repository: as the Runner's owner works on GitHub,
 *  else the org's Outrunner App. */
async function tokenFor(runner: Workspace, repo: string): Promise<string | null> {
  const orgId = runner.orgId;
  if (!orgId) return null;
  return (await optionalGitToken(runner.ownerId, { orgId, fullName: repo })) ?? (await repoToken(orgId, repo).catch(() => null));
}

/** The Runner's repositories' full names. */
async function runnerRepos(runner: Workspace): Promise<string[]> {
  const ids = runner.checkouts?.map((c) => c.projectId) ?? [runner.projectId];
  const { data } = await db().from("projects").select("full_name").in("id", ids);
  return (data ?? []).map((p) => p.full_name);
}

/** Look on GitHub for the Runner's pull requests from its own branch, for
 *  when no webhook said (the App not installed, or a delivery lost). */
export async function discoverRunnerPullRequests(runner: Workspace): Promise<void> {
  for (const repo of await runnerRepos(runner)) {
    const token = await tokenFor(runner, repo);
    if (!token) continue;
    const owner = repo.split("/")[0];
    const pulls = await githubGet<GitHubPull[]>(token, `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${runner.branch}`)}&state=all&per_page=20`);
    for (const pull of pulls ?? []) {
      if (!pull.number || !pull.head?.ref) continue;
      const { data: known } = await db().from("runner_pull_requests").select("number").eq("runner_id", runner.id).eq("repo", repo).eq("number", pull.number).maybeSingle();
      if (known) continue;
      await db().from("runner_pull_requests").upsert(
        {
          runner_id: runner.id,
          repo,
          number: pull.number,
          url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
          title: pull.title ?? "",
          head_ref: pull.head.ref,
          base_ref: pull.base?.ref ?? null,
          head_sha: pull.head.sha ?? null,
        },
        { onConflict: "runner_id,repo,number", ignoreDuplicates: true },
      );
    }
  }
}

/**
 * Decide each of the Runner's open pull requests that's due, and tell its
 * Mission what's news; archive the Runner once all are merged or closed.
 */
export async function settleRunner(runner: Workspace, now = Date.now()): Promise<void> {
  const missionId = runner.parentMissionId;
  if (!missionId) return;
  const { data: rows, error } = await db().from("runner_pull_requests").select("*").eq("runner_id", runner.id);
  if (error) throw error;
  if (!rows?.length) return;
  const name = runner.title ?? runner.branch;
  // A fix running: the Runner mid-turn (GitHub's follow-ups run in its own
  // session), or one the GitHub agent loop has queued for it and not yet
  // sent (github_followups, lib/github/followups.ts).
  const working = await sessionWorking(runner).catch(() => false);
  for (const row of rows.filter((r) => r.state === "open")) {
    const { count: queuedFixes } = await db()
      .from("github_followups")
      .select("id", { count: "exact", head: true })
      .ilike("repo_full_name", row.repo.replace(/[\\%_]/g, "\\$&"))
      .eq("pr_number", row.number)
      .is("sent_at", null);
    const fixRunning = working || (queuedFixes ?? 0) > 0;
    const token = await tokenFor(runner, row.repo);
    if (!token) continue;
    const status = await getPullRequestStatus({ token, repoFullName: row.repo, number: row.number }).catch(() => null);
    if (!status) continue;
    const reviews = (await githubGet<Parameters<typeof reviewState>[0][number][]>(token, `/repos/${row.repo}/pulls/${row.number}/reviews?per_page=100`)) ?? [];
    const pull = await githubGet<GitHubPull>(token, `/repos/${row.repo}/pulls/${row.number}`);
    const runs = await githubGet<{ check_runs?: { name?: string; status?: string; conclusion?: string | null; html_url?: string }[] }>(
      token,
      `/repos/${row.repo}/commits/${status.headSha}/check-runs?per_page=100`,
    );
    const reviewed = reviewState(reviews);
    // A base that's another open pull request's head: stacked on it.
    const stackedOn = rows.find((r) => r.repo === row.repo && r.state === "open" && r.head_ref === (pull?.base?.ref ?? row.base_ref))?.number ?? null;
    const decision = settle({
      now,
      firstActivityAt: Date.parse(row.first_activity_at),
      lastActivityAt: Date.parse(row.last_activity_at),
      fixRunning,
      facts: { ...status, ...reviewed, stackedOn },
    });
    const pr: PullRequestRef = { repo: row.repo, number: row.number, url: row.url, title: pull?.title ?? row.title };
    const update = (patch: Record<string, unknown>) =>
      db()
        .from("runner_pull_requests")
        .update({
          checked_at: new Date(now).toISOString(),
          head_sha: status.headSha,
          title: pr.title,
          // What the Runners pane shows of it.
          additions: pull?.additions ?? null,
          deletions: pull?.deletions ?? null,
          checks: (runs?.check_runs ?? []).slice(0, 50).map((r) => ({
            name: r.name ?? "check",
            status: r.status ?? "completed",
            conclusion: r.conclusion ?? null,
            url: r.html_url ?? null,
          })),
          review_state: reviewed.changesRequested ? "changes_requested" : reviewed.approved ? "approved" : "none",
          mergeable_state: status.mergeableState,
          ...patch,
        })
        .eq("runner_id", runner.id)
        .eq("repo", row.repo)
        .eq("number", row.number);
    if (decision.kind === "merged" || decision.kind === "closed") {
      await update({ state: decision.kind });
      row.state = decision.kind;
      await recordMissionEvent({
        missionId,
        runnerId: runner.id,
        kind: decision.kind,
        payload: { runner: name, pr },
        key: eventKey.ended(decision.kind, runner.id, pr),
      });
      continue;
    }
    if (decision.kind === "wait") {
      await update({});
      continue;
    }
    const decided = { verdict: decision.kind, sha: status.headSha };
    if (!isNews(decided, { verdict: row.reported_verdict, sha: row.reported_sha })) {
      await update({ verdict: decision.kind, verdict_reason: decision.reason });
      continue;
    }
    const seq = row.decision_seq + 1;
    // Only the one that moved the count on reports it: two ticks deciding
    // at once both try, and one finds the count moved.
    const { data: claimed } = await update({
      verdict: decision.kind,
      verdict_reason: decision.reason,
      reported_verdict: decision.kind,
      reported_sha: status.headSha,
      decision_seq: seq,
    })
      .eq("decision_seq", row.decision_seq)
      .select("number");
    if (!claimed?.length) continue;
    await recordMissionEvent({
      missionId,
      runnerId: runner.id,
      kind: decision.kind,
      payload: { runner: name, pr, reason: decision.reason },
      key: eventKey.decision(runner.id, pr, seq),
    });
    // Ready is the user's to hear too, as a notification on the Mission under
    // their preferences (browser, email, Slack): once a decision.
    if (decision.kind === "ready") {
      const mission = await sessionById(missionId).catch(() => null);
      await recordNotifications([
        readyNotification({ ownerId: runner.ownerId, missionId, missionTitle: mission?.title ?? "Mission", runnerName: name, runnerId: runner.id, pr, seq }),
      ]).catch((error: unknown) => console.error(`Mission ${missionId}: couldn't record #${pr.number} ready`, error));
    }
  }
  if (allPullRequestsDone(rows.map((r) => r.state))) await archiveDoneRunner(runner, missionId);
}

/** All its pull requests merged or closed: the Runner's work is done, and it
 *  is archived, unless it's mid-turn or has messages waiting (then the next
 *  look does it). */
async function archiveDoneRunner(runner: Workspace, missionId: string): Promise<void> {
  if (!isLiveRunner(runner) || runner.status === "archiving") return;
  if (await sessionWorking(runner).catch(() => true)) return;
  if (((await queuedCounts([runner.id])).get(runner.id) ?? 0) > 0) return;
  if (runner.status === "creating" || runner.status === "provisioning") return;
  const archived = await actAsUser(runner.ownerId, async () => {
    const params = { params: Promise.resolve({ id: runner.id }) };
    const lifecycle = (action: string) => lifecyclePOST(asBrowser(`/api/workspaces/${runner.id}/lifecycle`, { action }), params);
    if (runner.status === "suspended" && !(await lifecycle("resume")).ok) return false;
    return (await lifecycle("archive")).ok;
  }).catch(() => false);
  if (!archived) return;
  await recordMissionEvent({
    missionId,
    runnerId: runner.id,
    kind: "archived",
    payload: { runner: runner.title ?? runner.branch, reason: "all its pull requests are merged or closed" },
    key: eventKey.archived(runner.id, runner.updatedAt),
  });
}

/** The tick's part: Runners with open pull requests due a look, and live
 *  Runners' pull requests no webhook announced. */
export async function settleDueRunners(limit = 30): Promise<number> {
  const { data, error } = await db()
    .from("runner_pull_requests")
    .select("runner_id")
    .eq("state", "open")
    .or(`checked_at.is.null,checked_at.lt.${new Date(Date.now() - 90_000).toISOString()}`)
    .limit(limit * 3);
  if (error) throw error;
  const due = new Set((data ?? []).map((r) => r.runner_id));
  // Runners' pull requests no webhook announced: live Runners', and those
  // of Runners archived lately with none found yet (one archived with force
  // still has its pull request to follow).
  const { data: recent } = await db()
    .from("workspaces")
    .select("id, status")
    .not("parent_mission_id", "is", null)
    .in("status", ["ready", "idle", "suspended", "archived"])
    .gt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(limit * 2);
  const { data: known } = await db()
    .from("runner_pull_requests")
    .select("runner_id")
    .in(
      "runner_id",
      (recent ?? []).map((r) => r.id),
    );
  const withRows = new Set((known ?? []).map((r) => r.runner_id));
  for (const r of (recent ?? []).filter((r) => r.status !== "archived" || !withRows.has(r.id)).slice(0, limit)) {
    const runner = await sessionById(r.id);
    if (!runner) continue;
    await discoverRunnerPullRequests(runner).catch((e: unknown) => console.warn(`Runner ${r.id}: pull request lookup failed`, e));
    due.add(r.id);
  }
  let settled = 0;
  for (const id of [...due].slice(0, limit)) {
    const runner = await sessionById(id);
    if (!runner) continue;
    await settleRunner(runner)
      .then(() => settled++)
      .catch((e: unknown) => console.error(`Runner ${id}: settling its pull requests failed`, e));
  }
  return settled;
}
