/**
 * Automations' runs (supabase/migrations/20261030140000_automation_runs.sql),
 * and the automations a pull request event concerns. The tables are the
 * server's alone, so this reaches them with the service role: the webhook,
 * signed by GitHub, records and settles runs; the Automations page reads an
 * org's for its members.
 */

import type { CheckOutcome } from "@/lib/automations/checks";
import type { AutomationTrigger } from "@/lib/automations/rules";
import { currentRunners } from "@/lib/db/automations";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An enabled automation a pull request event may start, on one repository. */
export type RunCandidate = {
  automationId: string;
  name: string;
  prompt: string;
  triggers: AutomationTrigger[];
  /** Who set it up; null once they've left the org or lost their account.
   *  A team org's runs are its connector's, not theirs (runnerFor). */
  runsAs: string | null;
  projectId: string;
  orgId: string;
};

/**
 * The enabled automations on `repoFullName` in the org that has the
 * installation the event came through (github_installations, claimed and not
 * suspended): no other org gets anything from its events.
 */
export async function automationsForPullRequest(installationId: number, repoFullName: string): Promise<RunCandidate[]> {
  const supabase = createSupabaseAdminClient();
  const scope = await installationProjects(supabase, installationId, repoFullName);
  if (!scope) return [];
  const { orgId, projectIds } = scope;

  const { data: repos, error: reposError } = await supabase
    .from("automation_repos")
    .select("automation_id, project_id")
    .in("project_id", projectIds);
  if (reposError) throw reposError;
  if (!repos?.length) return [];

  const { data: automations, error: automationsError } = await supabase
    .from("automations")
    .select("id, org_id, name, prompt, triggers, runs_as")
    .in(
      "id",
      repos.map((r) => r.automation_id),
    )
    .eq("org_id", orgId)
    .eq("enabled", true);
  if (automationsError) throw automationsError;
  const byId = new Map((automations ?? []).map((a) => [a.id, a]));
  // A runner who has left the org (their account kept) runs nothing more:
  // their allowance isn't the org's to spend.
  const stillMembers = await currentRunners(
    orgId,
    (automations ?? []).flatMap((a) => (a.runs_as ? [a.runs_as] : [])),
  );
  return repos.flatMap((r) => {
    const a = byId.get(r.automation_id);
    if (!a) return [];
    const runsAs = a.runs_as && stillMembers.has(a.runs_as) ? a.runs_as : null;
    return [
      { automationId: a.id, name: a.name, prompt: a.prompt, triggers: a.triggers, runsAs, projectId: r.project_id, orgId },
    ];
  });
}

/** The org holding the installation (claimed and not suspended), and its
 *  projects that are `repoFullName`: no other org's are an event's. */
async function installationProjects(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  installationId: number,
  repoFullName: string,
): Promise<{ orgId: string; projectIds: string[] } | null> {
  const { data: holder, error } = await supabase
    .from("github_installations")
    .select("org_id")
    .eq("installation_id", installationId)
    .is("suspended_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!holder?.org_id) return null;
  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", holder.org_id)
    .ilike("full_name", repoFullName.replace(/[\\%_]/g, "\\$&"));
  if (projectsError) throw projectsError;
  const projectIds = (projects ?? []).map((p) => p.id);
  return projectIds.length === 0 ? null : { orgId: holder.org_id, projectIds };
}

/**
 * The open sessions of the automations' runs on a pull request, by their
 * owner (the runner each was started as), for it closing to archive them.
 */
export async function pullRequestSessions(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<Map<string, string[]>> {
  const supabase = createSupabaseAdminClient();
  const scope = await installationProjects(supabase, installationId, repoFullName);
  if (!scope) return new Map();
  const { data: runs, error } = await supabase
    .from("automation_runs")
    .select("workspace_id")
    .in("project_id", scope.projectIds)
    .eq("pr_number", prNumber)
    .not("workspace_id", "is", null);
  if (error) throw error;
  const ids = [...new Set((runs ?? []).flatMap((r) => (r.workspace_id ? [r.workspace_id] : [])))];
  if (ids.length === 0) return new Map();
  const { data: sessions, error: sessionsError } = await supabase
    .from("workspaces")
    .select("id, owner_id")
    .in("id", ids)
    .in("status", ["ready", "idle"]);
  if (sessionsError) throw sessionsError;
  const byOwner = new Map<string, string[]>();
  for (const s of sessions ?? []) byOwner.set(s.owner_id, [...(byOwner.get(s.owner_id) ?? []), s.id]);
  return byOwner;
}

/**
 * Record runs in one statement, all or none: the new ones' ids, by
 * `${automationId}:${projectId}`. One whose automation already ran for this
 * pull request at this commit (a redelivery, a repeated event) is left out.
 */
export async function recordRuns(
  runs: { automationId: string; projectId: string; prNumber: number; prTitle: string; headSha: string }[],
): Promise<Map<string, string>> {
  if (runs.length === 0) return new Map();
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .upsert(
      runs.map((run) => ({
        automation_id: run.automationId,
        project_id: run.projectId,
        pr_number: run.prNumber,
        pr_title: run.prTitle,
        head_sha: run.headSha,
      })),
      { onConflict: "automation_id,project_id,pr_number,head_sha", ignoreDuplicates: true },
    )
    .select("id, automation_id, project_id");
  if (error) throw error;
  return new Map((data ?? []).map((r) => [`${r.automation_id}:${r.project_id}`, r.id]));
}

/** How long a run may stay "started" before it's taken to have been cut off:
 *  a cold box's setup takes minutes, never this long. */
export const RUN_SETUP_MINUTES = 30;

/**
 * Runs whose setup a restart or a deploy cut off: started RUN_SETUP_MINUTES
 * ago or more and never settled (only after() starts a run, and a
 * redelivery doesn't record it again). Said as such rather than left
 * "Starting"; the reconciler's cron calls this. How many.
 */
export async function sweepStalledRuns(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - RUN_SETUP_MINUTES * 60_000).toISOString();
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({
      status: "refused",
      reason: "Its session's setup never finished. Run it again, or push new commits to the pull request.",
      updated_at: now.toISOString(),
    })
    .eq("status", "started")
    .lt("updated_at", before)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Keep how a run went. */
export async function settleRun(
  runId: string,
  outcome: { status: "started" | "ready" | "failed" | "refused"; workspaceId?: string | null; reason?: string | null },
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({
      status: outcome.status,
      ...(outcome.workspaceId !== undefined ? { workspace_id: outcome.workspaceId } : {}),
      reason: outcome.reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw error;
}

/** A run, as the Automations page shows it. */
export type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  headSha: string;
  workspaceId: string | null;
  status: "started" | "ready" | "failed" | "refused";
  reason: string | null;
  createdAt: string;
};

/** How many of an org's latest runs the Automations page loads. */
export const RECENT_RUNS = 50;

/** An org's latest runs, newest first. */
export async function listRuns(orgId: string, limit = RECENT_RUNS, onlyId?: string): Promise<AutomationRun[]> {
  const supabase = createSupabaseAdminClient();
  const { data: automations, error } = await supabase.from("automations").select("id, name").eq("org_id", orgId);
  if (error) throw error;
  if (!automations?.length) return [];
  const { data: runs, error: runsError } = await supabase
    .from("automation_runs")
    .select("id, automation_id, project_id, pr_number, pr_title, head_sha, workspace_id, status, reason, created_at")
    .in(
      "automation_id",
      automations.map((a) => a.id),
    )
    .match(onlyId ? { id: onlyId } : {})
    .order("created_at", { ascending: false })
    .limit(limit);
  if (runsError) throw runsError;
  const projectIds = [...new Set((runs ?? []).map((r) => r.project_id))];
  const { data: projects, error: projectsError } = projectIds.length
    ? await supabase.from("projects").select("id, full_name").in("id", projectIds)
    : { data: [], error: null };
  if (projectsError) throw projectsError;
  const nameOf = new Map(automations.map((a) => [a.id, a.name]));
  const repoOf = new Map((projects ?? []).map((p) => [p.id, p.full_name]));
  return (runs ?? []).map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    automationName: nameOf.get(r.automation_id) ?? "",
    repoFullName: repoOf.get(r.project_id) ?? "",
    prNumber: r.pr_number,
    prTitle: r.pr_title,
    headSha: r.head_sha,
    workspaceId: r.workspace_id,
    status: r.status,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/** One of an org's runs, as the Automations page shows it; null when it
 *  isn't the org's. */
export async function getRun(orgId: string, runId: string): Promise<AutomationRun | null> {
  return (await listRuns(orgId, 1, runId))[0] ?? null;
}

/**
 * Where a run stands among the automation's runs on its pull request, by when
 * each was recorded (runs set up side by side, and a later commit's can be
 * ready first): the sessions of the runs before it, and whether one after it
 * is ready already, when its own session is the stale one.
 */
export async function runNeighbours(run: {
  runId: string;
  automationId: string;
  projectId: string;
  prNumber: number;
}): Promise<{ earlierSessions: string[]; superseded: boolean }> {
  const supabase = createSupabaseAdminClient();
  const { data: self, error: selfError } = await supabase
    .from("automation_runs")
    .select("created_at")
    .eq("id", run.runId)
    .single();
  if (selfError) throw selfError;
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id, workspace_id, status, created_at")
    .eq("automation_id", run.automationId)
    .eq("project_id", run.projectId)
    .eq("pr_number", run.prNumber)
    .neq("id", run.runId);
  if (error) throw error;
  const others = data ?? [];
  return {
    earlierSessions: others.flatMap((r) => (r.created_at < self.created_at && r.workspace_id ? [r.workspace_id] : [])),
    // Taken over only by a later run that's ready: one still setting up
    // archives this one itself once it is, and one that failed or didn't
    // start leaves this as the pull request's review.
    superseded: others.some((r) => r.created_at > self.created_at && r.status === "ready"),
  };
}

/** What running a run again needs: the run, its automation as a candidate,
 *  its repository and the org's installation on its account. */
export type RerunTarget = {
  runId: string;
  status: AutomationRun["status"];
  headSha: string;
  prNumber: number;
  enabled: boolean;
  candidate: RunCandidate;
  repoFullName: string;
  /** The org's installation (claimed, not suspended) on the repository's
   *  account; null when it has none. */
  installationId: number | null;
  /** None live on the account, but one suspended: it can't post until it's
   *  unsuspended. */
  installationSuspended: boolean;
  /** Whether the automation still covers the repository (automation_repos). */
  covered: boolean;
  /** The session the run made, if any: archived before it starts over. */
  workspaceId: string | null;
};

/** One of the org's runs, to run again; null when it isn't the org's. */
export async function rerunTarget(orgId: string, runId: string): Promise<RerunTarget | null> {
  const supabase = createSupabaseAdminClient();
  const { data: run, error } = await supabase
    .from("automation_runs")
    .select("id, automation_id, project_id, pr_number, head_sha, status, workspace_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const { data: automation, error: automationError } = await supabase
    .from("automations")
    .select("id, name, prompt, triggers, runs_as, enabled")
    .eq("id", run.automation_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (automationError) throw automationError;
  if (!automation) return null;
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("full_name")
    .eq("id", run.project_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project?.full_name) return null;
  const { data: covering, error: coveringError } = await supabase
    .from("automation_repos")
    .select("project_id")
    .eq("automation_id", run.automation_id)
    .eq("project_id", run.project_id)
    .maybeSingle();
  if (coveringError) throw coveringError;
  const { data: installations, error: installationsError } = await supabase
    .from("github_installations")
    .select("installation_id, account_login, suspended_at")
    .eq("org_id", orgId);
  if (installationsError) throw installationsError;
  const owner = project.full_name.split("/")[0].toLowerCase();
  // A live one if there is; else a suspended one, to say so.
  const onAccount = (installations ?? []).filter((i) => i.account_login.toLowerCase() === owner);
  const installation = onAccount.find((i) => i.suspended_at === null);
  const stillMember = automation.runs_as ? await currentRunners(orgId, [automation.runs_as]) : new Set<string>();
  return {
    runId: run.id,
    status: run.status,
    headSha: run.head_sha,
    prNumber: run.pr_number,
    enabled: automation.enabled,
    candidate: {
      automationId: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      triggers: automation.triggers,
      runsAs: automation.runs_as && stillMember.has(automation.runs_as) ? automation.runs_as : null,
      projectId: run.project_id,
      orgId,
    },
    repoFullName: project.full_name,
    installationId: installation?.installation_id ?? null,
    installationSuspended: !installation && onAccount.length > 0,
    covered: covering !== null,
    workspaceId: run.workspace_id,
  };
}

/** Set a run that failed or didn't start back to starting, to run again;
 *  false when it isn't one any more (it's running again already). */
export async function reopenRun(runId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ status: "started", workspace_id: null, reason: null, updated_at: new Date().toISOString() })
    .eq("id", runId)
    .in("status", ["failed", "refused"])
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Who a session is: its owner, as whom it's archived; null when it's gone. */
export async function sessionOwner(workspaceId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data?.owner_id ?? null;
}

/**
 * A run's session when it's the org's connector's, for the org's admins to
 * read (lib/automations/review-view.ts): no one else's session, and no run
 * of another org's. Null otherwise.
 */
export async function connectorRunSession(
  orgId: string,
  runId: string,
): Promise<{ workspaceId: string; connectorId: string } | null> {
  const supabase = createSupabaseAdminClient();
  const { data: run, error } = await supabase
    .from("automation_runs")
    .select("automation_id, workspace_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!run?.workspace_id) return null;
  const [automation, connector, session] = await Promise.all([
    supabase.from("automations").select("id").eq("id", run.automation_id).eq("org_id", orgId).maybeSingle(),
    supabase.from("org_connectors").select("user_id").eq("org_id", orgId).maybeSingle(),
    supabase.from("workspaces").select("owner_id, org_id, status").eq("id", run.workspace_id).maybeSingle(),
  ]);
  for (const read of [automation, connector, session]) if (read.error) throw read.error;
  if (!automation.data || !connector.data || !session.data) return null;
  if (session.data.owner_id !== connector.data.user_id || session.data.org_id !== orgId) return null;
  if (session.data.status === "destroyed") return null;
  return { workspaceId: run.workspace_id, connectorId: connector.data.user_id };
}

/** Keep a run's check: opened on GitHub, through this installation. */
export async function recordCheck(runId: string, checkRunId: number, installationId: number): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ check_run_id: checkRunId, check_installation_id: installationId })
    .eq("id", runId);
  if (error) throw error;
}

/** Where a run's check is on GitHub, and the pull request it's on. */
export type OpenCheck = {
  checkRunId: number;
  installationId: number;
  repoFullName: string;
  prNumber: number;
};

/** A run's check, however it stands: closed (GitHub took a close), and the
 *  review's outcome once one was posted. Null when it has none. */
export type CheckState = { check: OpenCheck; closed: boolean; review: CheckOutcome | null };

export async function checkStateOf(runId: string): Promise<CheckState | null> {
  const supabase = createSupabaseAdminClient();
  const { data: run, error } = await supabase
    .from("automation_runs")
    .select("project_id, pr_number, check_run_id, check_installation_id, check_closed_at, check_review")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!run?.check_run_id || !run.check_installation_id) return null;
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("full_name")
    .eq("id", run.project_id)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project?.full_name) return null;
  return {
    check: {
      checkRunId: run.check_run_id,
      installationId: run.check_installation_id,
      repoFullName: project.full_name,
      prNumber: run.pr_number,
    },
    closed: run.check_closed_at !== null,
    review: (run.check_review as CheckOutcome | null) ?? null,
  };
}

/** Take a run's open check to close without a review: true for the one
 *  call that does, and never once its review is in. */
export async function claimCheck(runId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ check_closed_at: new Date().toISOString() })
    .eq("id", runId)
    .not("check_run_id", "is", null)
    .is("check_closed_at", null)
    .is("check_reviewed_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Give back a claim whose close GitHub didn't take, for the sweep to try
 *  again: unless the review is in meanwhile, whose the check is now. */
export async function releaseCheck(runId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ check_closed_at: null })
    .eq("id", runId)
    .is("check_reviewed_at", null);
  if (error) throw error;
}

/** The run's review is in: its outcome is the check's from now on, sent
 *  until GitHub takes it (markCheckClosed). */
export async function markCheckReviewed(runId: string, outcome: CheckOutcome): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ check_reviewed_at: new Date().toISOString(), check_review: outcome, check_closed_at: null })
    .eq("id", runId);
  if (error) throw error;
}

/** GitHub took the check's close. */
export async function markCheckClosed(runId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .update({ check_closed_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw error;
}

/** The runs on a pull request (it closed) whose check is open, with no
 *  review in. */
export async function openChecksOfPullRequest(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<string[]> {
  const supabase = createSupabaseAdminClient();
  const scope = await installationProjects(supabase, installationId, repoFullName);
  if (!scope) return [];
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id")
    .in("project_id", scope.projectIds)
    .eq("pr_number", prNumber)
    .not("check_run_id", "is", null)
    .is("check_closed_at", null)
    .is("check_reviewed_at", null);
  if (error) throw error;
  return (data ?? []).map((r) => r.id);
}

/** How long the sweep keeps trying a check GitHub won't take (the App
 *  uninstalled, the repository gone, Checks taken away): a day. */
const CHECK_RETRY_DAY_MS = 24 * 3_600_000;

/** For the sweep, newest first: the runs whose check is open from before
 *  `before` with no review in, and those whose review GitHub hasn't taken
 *  since `retryBefore`; none older than a day, so ones GitHub never takes
 *  stop being tried, and never crowd out those it would. */
export async function checksToSweep(before: Date, retryBefore: Date): Promise<{ stale: string[]; unsent: string[] }> {
  const supabase = createSupabaseAdminClient();
  const [stale, unsent] = await Promise.all([
    supabase
      .from("automation_runs")
      .select("id")
      .not("check_run_id", "is", null)
      .is("check_closed_at", null)
      .is("check_reviewed_at", null)
      .lt("created_at", before.toISOString())
      .gt("created_at", new Date(before.getTime() - CHECK_RETRY_DAY_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("automation_runs")
      .select("id")
      .not("check_run_id", "is", null)
      .is("check_closed_at", null)
      .lt("check_reviewed_at", retryBefore.toISOString())
      .gt("check_reviewed_at", new Date(retryBefore.getTime() - CHECK_RETRY_DAY_MS).toISOString())
      .order("check_reviewed_at", { ascending: false })
      .limit(100),
  ]);
  if (stale.error) throw stale.error;
  if (unsent.error) throw unsent.error;
  return { stale: (stale.data ?? []).map((r) => r.id), unsent: (unsent.data ?? []).map((r) => r.id) };
}
