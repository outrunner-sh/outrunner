/**
 * Automations' runs (supabase/migrations/20261030140000_automation_runs.sql),
 * and the automations an event or a schedule concerns. The tables are the
 * server's alone, so this reaches them with the service role: the webhook,
 * signed by GitHub, and the cron's tick record and settle runs; the
 * Automations page reads an org's for its members.
 */

import type { CheckOutcome } from "@/lib/automations/checks";
import { readRunEvent, type RunEvent } from "@/lib/automations/run-event";
import type { AutomationTrigger, RunStatus, SessionMode, TriggerKind } from "@/lib/automations/rules";
import { type Schedule, scheduleFromRow } from "@/lib/automations/schedule";
import { currentRunners, timesRun } from "@/lib/db/automations";
import { installationProjectsOf } from "@/lib/db/installation-projects";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An enabled automation an event may start, on one repository. */
export type RunCandidate = {
  automationId: string;
  name: string;
  prompt: string;
  triggers: AutomationTrigger[];
  /** Who set it up; null once they've left the org or lost their account.
   *  A team org's runs are its connector's, not theirs (runnerFor). */
  runsAs: string | null;
  projectId: string;
  /** The repository, `owner/name`: its session is told. */
  repoFullName: string;
  orgId: string;
  /** Whose review requests, and which labels, start it (filtersTake). */
  reviewers: string[];
  labels: string[];
  /** A new session each run, or its last one on the repository. */
  sessionMode: SessionMode;
};

type Admin = ReturnType<typeof createSupabaseAdminClient>;

/**
 * The enabled automations of `orgId` among `automationIds`, as candidates on
 * each of their repositories (or those of them in `projectIds`). One whose
 * runner left the org (their account kept) is a candidate with no runner: it
 * runs nothing more (their allowance isn't the org's to spend), and its run
 * says so.
 */
async function candidatesOf(
  supabase: Admin,
  orgId: string,
  links: readonly { automation_id: string; project_id: string }[],
  { enabledOnly = true }: { enabledOnly?: boolean } = {},
): Promise<RunCandidate[]> {
  if (links.length === 0) return [];
  let automationsQuery = supabase
    .from("automations")
    .select("id, org_id, name, prompt, triggers, runs_as, reviewers, labels, session_mode")
    .in("id", [...new Set(links.map((l) => l.automation_id))])
    .eq("org_id", orgId);
  if (enabledOnly) automationsQuery = automationsQuery.eq("enabled", true);
  const [automations, projects] = await Promise.all([
    automationsQuery,
    supabase
      .from("projects")
      .select("id, full_name")
      .in("id", [...new Set(links.map((l) => l.project_id))])
      .eq("org_id", orgId),
  ]);
  if (automations.error) throw automations.error;
  if (projects.error) throw projects.error;
  const byId = new Map((automations.data ?? []).map((a) => [a.id, a]));
  const repoOf = new Map((projects.data ?? []).map((p) => [p.id, p.full_name]));
  const stillMembers = await currentRunners(
    orgId,
    (automations.data ?? []).flatMap((a) => (a.runs_as ? [a.runs_as] : [])),
  );
  return links.flatMap((r) => {
    const a = byId.get(r.automation_id);
    const repoFullName = repoOf.get(r.project_id);
    if (!a || !repoFullName) return [];
    const runsAs = a.runs_as && stillMembers.has(a.runs_as) ? a.runs_as : null;
    return [
      {
        automationId: a.id,
        name: a.name,
        prompt: a.prompt,
        triggers: a.triggers,
        runsAs,
        projectId: r.project_id,
        repoFullName,
        orgId,
        reviewers: a.reviewers,
        labels: a.labels,
        sessionMode: a.session_mode,
      },
    ];
  });
}

/**
 * The enabled automations on `repoFullName` in every org linked to the
 * installation, while it is not suspended.
 */
export async function automationsForPullRequest(installationId: number, repoFullName: string): Promise<RunCandidate[]> {
  const supabase = createSupabaseAdminClient();
  const scope = await installationProjects(supabase, installationId, repoFullName);
  if (!scope) return [];
  const { data: repos, error } = await supabase
    .from("automation_repos")
    .select("automation_id, project_id")
    .in("project_id", scope.projectIds);
  if (error) throw error;
  return (await Promise.all(scope.orgIds.map((orgId) => candidatesOf(supabase, orgId, repos ?? [])))).flat();
}

/** The linked orgs and their projects that are `repoFullName`
 *  (lib/db/installation-projects.ts). */
async function installationProjects(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  installationId: number,
  repoFullName: string,
): Promise<{ orgIds: string[]; projectIds: string[] } | null> {
  const { orgIds, projects } = await installationProjectsOf(supabase, installationId, repoFullName);
  const projectIds = projects.map((p) => p.id);
  return projectIds.length === 0 ? null : { orgIds, projectIds };
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
    .not("workspace_id", "is", null)
    // Not the runs its closing starts, just now: theirs are only beginning.
    .or(`trigger.is.null,trigger.not.in.("pull_request.closed","pull_request.merged")`);
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

/** A run to record: which automation, where, what started it, and the key
 *  that makes it once. */
export type RunRecord = {
  automationId: string;
  projectId: string;
  trigger: AutomationTrigger;
  /** The same key again records nothing (a redelivery, a repeated tick). */
  dedupeKey: string;
  /** What a debounce window combines on (eventSubject). */
  subject: string;
  event: RunEvent;
  prNumber?: number;
  prTitle?: string;
  headSha?: string;
  issueNumber?: number;
  scheduledFor?: string;
};

/** A run recorded: its id, and whether it waits out a debounce window (it
 *  may be one recorded before, that this trigger was combined into). */
export type Recorded = { runId: string; queued: boolean };

/**
 * Record runs in one transaction (record_automation_runs), all or none: by
 * `${automationId}:${projectId}`, the runs made, or waiting runs they were
 * combined into. None of an automation that's off or archived, none whose
 * key its automation already recorded on the repository (a redelivery, a
 * repeated event or tick), and none past its limit.
 */
export async function recordRuns(runs: readonly RunRecord[]): Promise<Map<string, Recorded>> {
  if (runs.length === 0) return new Map();
  const { data, error } = await createSupabaseAdminClient().rpc("record_automation_runs", {
    runs: runs.map((run) => ({
      automation_id: run.automationId,
      project_id: run.projectId,
      trigger: run.trigger,
      dedupe_key: run.dedupeKey,
      subject: run.subject,
      context: run.event as unknown as Json,
      pr_number: run.prNumber ?? null,
      pr_title: run.prTitle ?? "",
      head_sha: run.headSha ?? null,
      issue_number: run.issueNumber ?? null,
      scheduled_for: run.scheduledFor ?? null,
    })),
  });
  if (error) throw error;
  return new Map(
    (data ?? []).map((r) => [`${r.run_automation_id}:${r.run_project_id}`, { runId: r.run_id, queued: r.queued }]),
  );
}

/** A waiting run whose window has passed, taken to start: its event, the
 *  last combined into it. */
export type ClaimedRun = { runId: string; automationId: string; projectId: string; event: RunEvent | null; combined: number };

/**
 * Take the waiting runs whose window has passed by `now` to start them,
 * each by one caller only (the tick, or the server that recorded it, waiting
 * its window out): set to starting in the same statement that finds them.
 * Only `runId` when given.
 */
export async function claimQueuedRuns(now: Date, runId?: string): Promise<ClaimedRun[]> {
  let query = createSupabaseAdminClient()
    .from("automation_runs")
    .update({ status: "started", updated_at: now.toISOString() })
    .eq("status", "queued")
    .lte("not_before", now.toISOString());
  if (runId) query = query.eq("id", runId);
  // No limit on the update itself (PostgREST takes one only with an order):
  // few wait past their window, and each is taken once.
  const { data, error } = await query.select("id, automation_id, project_id, context, combined");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    runId: r.id,
    automationId: r.automation_id,
    projectId: r.project_id,
    event: readRunEvent(r.context),
    combined: r.combined,
  }));
}

/** When a waiting run's window ends now (a later trigger moves it on); null
 *  once it isn't waiting. */
export async function queuedUntil(runId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .select("status, not_before")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  return data?.status === "queued" ? data.not_before : null;
}

/** The automations' candidates on these repositories, on or off: a run
 *  recorded before one was switched off still runs. */
export async function claimedCandidates(runs: readonly { automationId: string; projectId: string }[]): Promise<RunCandidate[]> {
  if (runs.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const { data: orgs, error } = await supabase
    .from("automations")
    .select("id, org_id")
    .in("id", [...new Set(runs.map((r) => r.automationId))]);
  if (error) throw error;
  const orgOf = new Map((orgs ?? []).map((a) => [a.id, a.org_id]));
  const byOrg = new Map<string, { automation_id: string; project_id: string }[]>();
  for (const run of runs) {
    const orgId = orgOf.get(run.automationId);
    if (orgId) byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), { automation_id: run.automationId, project_id: run.projectId }]);
  }
  return (await Promise.all([...byOrg].map(([orgId, l]) => candidatesOf(supabase, orgId, l, { enabledOnly: false })))).flat();
}

/** The session an automation's last run on the same thing (`subject`) in a
 *  repository made, to give the next run's prompt to (session_mode
 *  'reuse'); null when there's none that can be woken. */
export async function reusableSession(run: {
  runId: string;
  automationId: string;
  projectId: string;
  subject: string;
}): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("automation_runs")
    .select("workspace_id")
    .eq("automation_id", run.automationId)
    .eq("project_id", run.projectId)
    .eq("subject", run.subject)
    .neq("id", run.runId)
    .not("workspace_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.workspace_id) return null;
  const { data: session, error: sessionError } = await supabase
    .from("workspaces")
    .select("id, status")
    .eq("id", data.workspace_id)
    .maybeSingle();
  if (sessionError) throw sessionError;
  return session && ["ready", "idle", "suspended", "archived"].includes(session.status) ? session.id : null;
}

/** A schedule that has come due, with its automation. */
export type DueSchedule = {
  scheduleId: string;
  automationId: string;
  schedule: Schedule;
  /** The time it came due: the run's, and its key. */
  dueAt: string;
};

/**
 * The schedules due by `now`, earliest first, of enabled automations that
 * run on a schedule. A due one of an automation that's off (or no longer
 * scheduled) has its next time cleared on the way: it's worked out again
 * when it's switched on, and it never crowds out the ones to run. So does
 * one that can't be read as a schedule any more (a zone this runtime no
 * longer knows, say), which nothing would ever move on; saving it again
 * gives it a next time.
 */
export async function dueSchedules(now: Date, limit = 100): Promise<DueSchedule[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("automation_schedules")
    .select("id, automation_id, kind, timezone, spec, next_run_at")
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  if (!data?.length) return [];
  const { data: automations, error: automationsError } = await supabase
    .from("automations")
    .select("id, enabled, triggers")
    .in("id", [...new Set(data.map((s) => s.automation_id))]);
  if (automationsError) throw automationsError;
  const live = new Set((automations ?? []).filter((a) => a.enabled && a.triggers.includes("schedule")).map((a) => a.id));
  const idle = data.filter((s) => !live.has(s.automation_id) || !scheduleFromRow(s)).map((s) => s.id);
  if (idle.length > 0) {
    const { error: clearError } = await supabase.from("automation_schedules").update({ next_run_at: null }).in("id", idle);
    if (clearError) throw clearError;
  }
  return data.flatMap((row) => {
    const schedule = scheduleFromRow(row);
    if (!live.has(row.automation_id) || !schedule || !row.next_run_at) return [];
    return [{ scheduleId: row.id, automationId: row.automation_id, schedule, dueAt: new Date(row.next_run_at).toISOString() }];
  });
}

/** Move a schedule on from `dueAt` to `next` (null: it's done), unless
 *  another tick has already: false then. */
export async function advanceSchedule(scheduleId: string, dueAt: string, next: string | null): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_schedules")
    .update({ next_run_at: next })
    .eq("id", scheduleId)
    .eq("next_run_at", dueAt)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * The enabled automations among `automationIds`, as candidates on each of
 * their repositories where the org's GitHub App is live (claimed, not
 * suspended): a schedule's or a webhook's run works on GitHub as the App, so
 * on a repository it can't reach it would only make a box that fails, every
 * time. A pull request's event comes through a live installation already
 * (installationProjects).
 */
export async function automationCandidates(automationIds: readonly string[]): Promise<RunCandidate[]> {
  if (automationIds.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const [links, orgs] = await Promise.all([
    supabase.from("automation_repos").select("automation_id, project_id").in("automation_id", [...automationIds]),
    supabase.from("automations").select("id, org_id").in("id", [...automationIds]),
  ]);
  if (links.error) throw links.error;
  if (orgs.error) throw orgs.error;
  const byOrg = new Map<string, { automation_id: string; project_id: string }[]>();
  const orgOf = new Map((orgs.data ?? []).map((a) => [a.id, a.org_id]));
  for (const link of links.data ?? []) {
    const orgId = orgOf.get(link.automation_id);
    if (orgId) byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), link]);
  }
  const candidates = (await Promise.all([...byOrg].map(([orgId, l]) => candidatesOf(supabase, orgId, l)))).flat();
  if (candidates.length === 0) return [];
  const { data: installations, error } = await supabase
    .from("org_github_installation_details")
    .select("org_id, account_login")
    .in("org_id", [...byOrg.keys()])
    .is("suspended_at", null);
  if (error) throw error;
  const live = new Set((installations ?? []).map((i) => `${i.org_id}:${i.account_login.toLowerCase()}`));
  return candidates.filter((c) => live.has(`${c.orgId}:${c.repoFullName.split("/")[0].toLowerCase()}`));
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
      reason: "Its session's setup never finished. Run it again.",
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
  /** What started it; null for a run from before triggers were kept (a
   *  pull request's). */
  trigger: AutomationTrigger | null;
  /** A pull request's run's; null for any other. */
  prNumber: number | null;
  prTitle: string;
  headSha: string | null;
  /** A schedule's run's time. */
  scheduledFor: string | null;
  /** An issue's run's. */
  issueNumber: number | null;
  /** How many triggers a debounce window combined into it. */
  combined: number;
  /** A waiting run's: when its window ends. */
  notBefore: string | null;
  workspaceId: string | null;
  status: RunStatus;
  reason: string | null;
  createdAt: string;
};

/** How many of an org's latest runs the Automations page loads. */
export const RECENT_RUNS = 50;

/** The `trigger` values of a kind: a pull request's include runs from
 *  before triggers were kept (null). */
function kindFilter(kind: TriggerKind): string {
  return kind === "pull_request" ? "trigger.is.null,trigger.like.pull_request.*" : `trigger.like.${kind}*`;
}

/** An org's latest runs, newest first: only `onlyId`, or only those a kind
 *  of trigger started, when given. */
export async function listRuns(
  orgId: string,
  limit = RECENT_RUNS,
  onlyId?: string,
  kind?: TriggerKind,
): Promise<AutomationRun[]> {
  const supabase = createSupabaseAdminClient();
  const { data: automations, error } = await supabase.from("automations").select("id, name").eq("org_id", orgId);
  if (error) throw error;
  if (!automations?.length) return [];
  let query = supabase
    .from("automation_runs")
    .select(
      "id, automation_id, project_id, trigger, pr_number, pr_title, head_sha, scheduled_for, issue_number, combined, not_before, workspace_id, status, reason, created_at",
    )
    .in(
      "automation_id",
      automations.map((a) => a.id),
    );
  if (onlyId) query = query.eq("id", onlyId);
  if (kind) query = query.or(kindFilter(kind));
  const { data: runs, error: runsError } = await query.order("created_at", { ascending: false }).limit(limit);
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
    trigger: r.trigger,
    prNumber: r.pr_number,
    prTitle: r.pr_title,
    headSha: r.head_sha,
    scheduledFor: r.scheduled_for,
    issueNumber: r.issue_number,
    combined: r.combined,
    notBefore: r.not_before,
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
  /** What started it, and the event its session was told (null for a run
   *  from before they were kept: a pull request's). */
  trigger: AutomationTrigger | null;
  event: RunEvent | null;
  /** A pull request's run's; null for any other. */
  headSha: string | null;
  prNumber: number | null;
  enabled: boolean;
  /** Whether it has run its count (off for that, then): a failed run of it
   *  still runs again. */
  atLimit: boolean;
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
    .select("id, automation_id, project_id, trigger, context, pr_number, head_sha, status, workspace_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const { data: automation, error: automationError } = await supabase
    .from("automations")
    .select("id, name, prompt, triggers, runs_as, enabled, max_runs, reviewers, labels, session_mode")
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
    .from("org_github_installation_details")
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
    trigger: run.trigger,
    event: readRunEvent(run.context),
    headSha: run.head_sha,
    prNumber: run.pr_number,
    enabled: automation.enabled,
    atLimit: automation.max_runs !== null && (await timesRun(automation.id)) >= automation.max_runs,
    candidate: {
      automationId: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      triggers: automation.triggers,
      runsAs: automation.runs_as && stillMember.has(automation.runs_as) ? automation.runs_as : null,
      projectId: run.project_id,
      repoFullName: project.full_name,
      orgId,
      reviewers: automation.reviewers,
      labels: automation.labels,
      sessionMode: automation.session_mode,
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
  // Only a pull request's run has a check.
  if (!run?.check_run_id || !run.check_installation_id || run.pr_number === null) return null;
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

/** Give up on the checks past checksToSweep's day: kept as closed, so the
 *  open-check index holds only the open (the sweep's warning is the record
 *  of it). How many. */
export async function abandonOldChecks(before: Date, retryBefore: Date): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const [stale, unsent] = await Promise.all([
    supabase
      .from("automation_runs")
      .update({ check_closed_at: now })
      .not("check_run_id", "is", null)
      .is("check_closed_at", null)
      .is("check_reviewed_at", null)
      .lte("created_at", new Date(before.getTime() - CHECK_RETRY_DAY_MS).toISOString())
      .select("id"),
    supabase
      .from("automation_runs")
      .update({ check_closed_at: now })
      .not("check_run_id", "is", null)
      .is("check_closed_at", null)
      .lte("check_reviewed_at", new Date(retryBefore.getTime() - CHECK_RETRY_DAY_MS).toISOString())
      .select("id"),
  ]);
  if (stale.error) throw stale.error;
  if (unsent.error) throw unsent.error;
  return (stale.data ?? []).length + (unsent.data ?? []).length;
}

/** Of these automations on these repositories, those with a run on
 *  `subject` (a pull request, an issue) touched since `since`, by
 *  `${automationId}:${projectId}`: what the App did there may be their own
 *  run's doing. By `updated_at`, not when it was recorded: a run that waited
 *  out a debounce window started long after. */
export async function recentlyRanOn(
  runs: readonly { automationId: string; projectId: string }[],
  subject: string,
  since: Date,
): Promise<Set<string>> {
  if (runs.length === 0) return new Set();
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_runs")
    .select("automation_id, project_id")
    .in("automation_id", [...new Set(runs.map((r) => r.automationId))])
    .in("project_id", [...new Set(runs.map((r) => r.projectId))])
    .eq("subject", subject)
    // Only runs that got going: one refused, or still waiting out its
    // window, has done nothing there.
    .not("status", "in", "(refused,queued)")
    .gte("updated_at", since.toISOString());
  if (error) throw error;
  return new Set((data ?? []).map((r) => `${r.automation_id}:${r.project_id}`));
}
