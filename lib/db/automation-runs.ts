/**
 * Automations' runs (supabase/migrations/20261030140000_automation_runs.sql),
 * and the automations a pull request event concerns. The tables are the
 * server's alone, so this reaches them with the service role: the webhook,
 * signed by GitHub, records and settles runs; the Automations page reads an
 * org's for its members.
 */

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
  const scope = await installationProjects(installationId, repoFullName);
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
  installationId: number,
  repoFullName: string,
): Promise<{ orgId: string; projectIds: string[] } | null> {
  const supabase = createSupabaseAdminClient();
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
  const scope = await installationProjects(installationId, repoFullName);
  if (!scope) return new Map();
  const supabase = createSupabaseAdminClient();
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
      reason: "Its session's setup never finished. New commits on the pull request run it again.",
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

/** An org's latest runs, newest first. */
export async function listRuns(orgId: string, limit = 50): Promise<AutomationRun[]> {
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
