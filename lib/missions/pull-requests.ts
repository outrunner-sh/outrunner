/**
 * A Runner's pull requests, followed to the end (docs/missions.md): found as
 * GitHub announces them (app/api/github/webhook) or as the tick looks, each
 * one's CI and review activity noted, and once that has been quiet a while,
 * decided from what GitHub says of it then (lib/missions/settle.ts): ready,
 * or needing attention. Merged or closed, its Mission hears so, and once all
 * of a Runner's are, the Runner is archived.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { getPullRequestStatusWithDetails } from "@/lib/github/client";
import { optionalGitToken } from "@/lib/github/identity.deps";
import { githubGet } from "@/lib/github/rest";
import { sessionWorking } from "@/lib/missions/box";
import { eventKey, type PullRequestRef } from "@/lib/missions/events";
import { isLiveRunner } from "@/lib/missions/rules";
import { allPullRequestsDone, isNews, reviewState, runnerOwning, settle } from "@/lib/missions/settle";
import { queuedCounts, sessionById } from "@/lib/missions/store";
import { readyNotification } from "@/lib/missions/events";
import { recordMissionEvent } from "@/lib/missions/watch.deps";
import { recordNotifications } from "@/lib/notifications/record";
import { repoToken } from "@/lib/slack/github";
import { toWorkspace } from "@/lib/db/mappers";
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function checkoutIds(checkouts: unknown): string[] {
  if (!Array.isArray(checkouts)) return [];
  return checkouts.flatMap((c) =>
    c && typeof c === "object" && typeof (c as { projectId?: unknown }).projectId === "string" ? [(c as { projectId: string }).projectId] : [],
  );
}

/**
 * The Runners an event in `repo` can be about: Runners in its orgs that work
 * in the repository (as their own, or as one of a session of several), and
 * of those, only the ones on a branch it names or with a pull request of
 * its on record. Check runs come many a push: this keeps each to a query or
 * two, whatever the number of Runners.
 */
async function runnersFor(activity: PullRequestActivity): Promise<Workspace[]> {
  const { data: projects, error } = await db().from("projects").select("id, org_id").ilike("full_name", escapeLike(activity.repo));
  if (error) throw error;
  if (!projects?.length) return [];
  const projectIds = new Set(projects.map((p) => p.id));
  // What it takes to match, read narrow: whole rows only for the few that do.
  const { data, error: runnersError } = await db()
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
    const { data: rows, error: rowsError } = await db()
      .from("runner_pull_requests")
      .select("runner_id")
      .in(
        "runner_id",
        inRepo.map((r) => r.id),
      )
      .ilike("repo", escapeLike(activity.repo))
      .in("number", activity.numbers);
    if (rowsError) throw rowsError;
    for (const row of rows ?? []) known.add(row.runner_id);
  }
  const matched = inRepo.filter((row) => known.has(row.id) || refs.some((ref) => runnerOwning(inRepo, ref) === row)).map((row) => row.id);
  if (matched.length === 0) return [];
  const { data: rows, error: rowsError } = await db().from("workspaces").select("*").in("id", matched);
  if (rowsError) throw rowsError;
  return (rows ?? []).map(toWorkspace);
}

/** Note what a webhook said: a new pull request of a Runner's recorded (or
 *  one closed and reopened, open again), and activity on one starting (or
 *  extending) its stretch. The Runners whose pull requests it touched. */
export async function notePullRequestActivity(activity: PullRequestActivity): Promise<string[]> {
  const touched = new Set<string>();
  const runners = await runnersFor(activity);
  const now = new Date().toISOString();
  for (const runner of runners) {
    const pr = activity.pr;
    if (pr && runnerOwning(runners, pr.headRef) === runner) {
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
            // A closed one reopened is watched again: nothing else sets its
            // state back to open. Merged and closed are the settler's, from
            // GitHub's own state.
            ...(pr.state === "open" && { state: "open" as const }),
          },
          { onConflict: "runner_id,repo,number", ignoreDuplicates: false },
        );
      if (error) throw error;
    }
    const { data: rows, error } = await db()
      .from("runner_pull_requests")
      .select("number, head_ref, verdict")
      .eq("runner_id", runner.id)
      .ilike("repo", escapeLike(activity.repo))
      .eq("state", "open");
    if (error) throw error;
    for (const row of rows ?? []) {
      if (!activity.numbers.includes(row.number) && !activity.headRefs.includes(row.head_ref)) continue;
      // A decided one starts a new stretch; an undecided one's goes on.
      const { error: updateError } = await db()
        .from("runner_pull_requests")
        .update({
          last_activity_at: now,
          verdict: null,
          verdict_reason: null,
          ...(row.verdict !== null && { first_activity_at: now }),
        })
        .eq("runner_id", runner.id)
        .eq("number", row.number)
        .ilike("repo", escapeLike(activity.repo));
      if (updateError) throw updateError;
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

/** The Runners by org and repository (`<org>\0<owner/name>`). */
async function reposOf(runners: Workspace[]): Promise<Map<string, Workspace[]>> {
  const ids = [...new Set(runners.flatMap((r) => r.checkouts?.map((c) => c.projectId) ?? [r.projectId]))];
  const byRepo = new Map<string, Workspace[]>();
  if (ids.length === 0) return byRepo;
  const { data, error } = await db().from("projects").select("id, full_name").in("id", ids);
  if (error) throw error;
  const name = new Map((data ?? []).map((p) => [p.id, p.full_name]));
  for (const runner of runners) {
    for (const id of runner.checkouts?.map((c) => c.projectId) ?? [runner.projectId]) {
      // By org too: another org that connected the same repository reads it
      // with a token of its own.
      const repo = name.get(id);
      if (repo) byRepo.set(`${runner.orgId ?? ""}\u0000${repo}`, [...(byRepo.get(`${runner.orgId ?? ""}\u0000${repo}`) ?? []), runner]);
    }
  }
  return byRepo;
}

/**
 * Look on GitHub for Runners' pull requests no webhook announced (the App
 * not installed, or a delivery lost): one list a repository, its most
 * recently updated, matched to each Runner's branches, its own and the
 * `<branch>-…` ones of stacked work. Runners with new ones found.
 */
export async function discoverRunnerPullRequests(runners: Workspace[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const [key, here] of await reposOf(runners)) {
    const repo = key.slice(key.indexOf("\u0000") + 1);
    // Read with the first of their owners whose token reads it: one with no
    // token, or one GitHub turns away (SSO not authorized, access removed),
    // leaves the others still tried.
    // Each token once: several owners fall back to the org's, and one that
    // timed out won't do better on a second try.
    let pulls: GitHubPull[] | null = null;
    const tried = new Set<string>();
    for (const runner of here) {
      const token = await tokenFor(runner, repo);
      if (!token || tried.has(token)) continue;
      tried.add(token);
      pulls = await githubGet<GitHubPull[]>(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
      if (pulls) break;
    }
    for (const pull of pulls ?? []) {
      if (!pull.number || !pull.head?.ref) continue;
      for (const runner of here.filter((r) => runnerOwning(here, pull.head!.ref!) === r)) {
        const { data: made, error } = await db()
          .from("runner_pull_requests")
          .upsert(
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
          )
          .select("number");
        if (error) throw error;
        if (made?.length) found.add(runner.id);
        // A closed one GitHub shows open again is followed again here too:
        // no webhook tells this path, and DO NOTHING can't reopen a row.
        if (pull.state === "open") {
          const at = new Date().toISOString();
          const { data: reopened, error: reopenError } = await db()
            .from("runner_pull_requests")
            .update({ state: "open", last_activity_at: at, first_activity_at: at, verdict: null, verdict_reason: null })
            .eq("runner_id", runner.id)
            .eq("repo", repo)
            .eq("number", pull.number)
            .eq("state", "closed")
            .select("number");
          if (reopenError) throw reopenError;
          if (reopened?.length) found.add(runner.id);
        }
      }
    }
  }
  return found;
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
    // The pull request, its checks and its details in one read, and its
    // reviews in another.
    const read = await getPullRequestStatusWithDetails({ token, repoFullName: row.repo, number: row.number }).catch(() => null);
    if (!read) continue;
    const { status, details } = read;
    const reviews = (await githubGet<Parameters<typeof reviewState>[0][number][]>(token, `/repos/${row.repo}/pulls/${row.number}/reviews?per_page=100`)) ?? [];
    const reviewed = reviewState(reviews);
    // A base that's another open pull request's head: stacked on it.
    const stackedOn = rows.find((r) => r.repo === row.repo && r.state === "open" && r.head_ref === (details.baseRef ?? row.base_ref))?.number ?? null;
    const decision = settle({
      now,
      firstActivityAt: Date.parse(row.first_activity_at),
      lastActivityAt: Date.parse(row.last_activity_at),
      fixRunning,
      facts: { ...status, ...reviewed, stackedOn },
    });
    const pr: PullRequestRef = { repo: row.repo, number: row.number, url: row.url, title: details.title || row.title };
    const update = (patch: Record<string, unknown>) =>
      db()
        .from("runner_pull_requests")
        .update({
          checked_at: new Date(now).toISOString(),
          head_sha: status.headSha,
          title: pr.title,
          // What the Runners pane shows of it.
          additions: details.additions,
          deletions: details.deletions,
          checks: details.checkRuns,
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
  // Automatic cleanup must save its files. If its box can't be reached,
  // leave it active so a person can decide whether to archive without them.
  const archived = await actAsUser(runner.ownerId, async () => {
    const params = { params: Promise.resolve({ id: runner.id }) };
    return (await lifecyclePOST(asBrowser(`/api/workspaces/${runner.id}/lifecycle`, { action: "archive", requireSnapshot: true }), params)).ok;
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

/** The tick's part: Runners with open pull requests due a look, Runners
 *  whose pull requests no webhook announced, and Runners whose pull requests
 *  are all done that are still to be archived. */
export async function settleDueRunners(limit = 30): Promise<number> {
  const { data, error } = await db()
    .from("runner_pull_requests")
    .select("runner_id")
    .eq("state", "open")
    .or(`checked_at.is.null,checked_at.lt.${new Date(Date.now() - 90_000).toISOString()}`)
    .limit(limit * 3);
  if (error) throw error;
  const due = new Set((data ?? []).map((r) => r.runner_id));
  // Runners lately at work: live ones, and those archived lately with none
  // found yet (one archived with force still has its pull request to follow).
  const { data: recent, error: recentError } = await db()
    .from("workspaces")
    .select("*")
    .not("parent_mission_id", "is", null)
    .in("status", ["ready", "idle", "suspended", "archived"])
    .gt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(limit * 2);
  if (recentError) throw recentError;
  const runners = (recent ?? []).map(toWorkspace);
  const { data: known, error: knownError } = await db()
    .from("runner_pull_requests")
    .select("runner_id, state")
    .in(
      "runner_id",
      runners.map((r) => r.id),
    );
  if (knownError) throw knownError;
  const states = new Map<string, string[]>();
  for (const row of known ?? []) states.set(row.runner_id, [...(states.get(row.runner_id) ?? []), row.state]);
  const looking = runners.filter((r) => r.status !== "archived" || !states.has(r.id));
  for (const id of await discoverRunnerPullRequests(looking).catch((e: unknown) => {
    console.warn("Missions: looking for Runners' pull requests failed", e);
    return new Set<string>();
  })) {
    due.add(id);
  }
  // All merged or closed, the Runner still up: archived (when it's at rest).
  for (const runner of runners) {
    if (runner.status !== "archived" && allPullRequestsDone((states.get(runner.id) ?? []) as ("open" | "merged" | "closed")[])) due.add(runner.id);
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
