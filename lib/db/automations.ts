/**
 * An org's automations (supabase/migrations/20261030130000_automations.sql).
 * The tables are the server's alone, so this reaches them with the service
 * role; the routes calling it check who may (the org's admins change them,
 * every member reads them). Making and changing one each go through a
 * database function: one transaction, which checks the repositories are the
 * org's.
 */

import {
  type Automation,
  type AutomationInput,
  type AutomationRepo,
  type AutomationTrigger,
  COVER_NEW_REPOS_TRIGGERS_ERROR,
} from "@/lib/automations/rules";
import { nextRun, type Schedule, scheduleFromRow, scheduleSpec } from "@/lib/automations/schedule";
import { automationTemplate, CODE_REVIEW_TEMPLATE_ID } from "@/lib/automations/templates";
import { webhookTokenSettings } from "@/lib/db/automation-webhooks";
import { people } from "@/lib/db/org-members";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An org's repositories (its projects), by name: what an automation may run on. */
export async function listOrgRepos(orgId: string): Promise<AutomationRepo[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("projects")
    .select("id, full_name")
    .eq("org_id", orgId)
    .order("full_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((p) => ({ projectId: p.id, fullName: p.full_name }));
}

type AutomationRowRead = {
  id: string;
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  enabled: boolean;
  runs_as: string | null;
  reviewers: string[];
  labels: string[];
  max_runs: number | null;
  archive_when_done: boolean;
  debounce_seconds: number;
  session_mode: "new" | "reuse";
  cover_new_repos: boolean;
  archived_at: string | null;
  runs_since: string;
  created_at: string;
};

const COLUMNS =
  "id, name, template, prompt, triggers, enabled, runs_as, reviewers, labels, max_runs, archive_when_done, debounce_seconds, session_mode, cover_new_repos, archived_at, runs_since, created_at";

/** The times an automation has run since its count began: each key once,
 *  however many repositories it ran on, as its limit is held to
 *  (automation_times_run, which record_automation_runs counts with). */
export async function timesRun(automationId: string): Promise<number> {
  const { data, error } = await createSupabaseAdminClient().rpc("automation_times_run", { automation: automationId });
  if (error) throw error;
  return data ?? 0;
}

/** The times each limited automation has run against its count. */
async function runsUsed(rows: readonly AutomationRowRead[]): Promise<Map<string, number>> {
  const limited = rows.filter((r) => r.max_runs !== null);
  return new Map(await Promise.all(limited.map(async (r) => [r.id, await timesRun(r.id)] as const)));
}

/**
 * Of `userIds`, those still members of the org: an automation runs only as
 * one of them (a runner who left keeps their account, and their allowance
 * isn't the org's to spend).
 */
export async function currentRunners(orgId: string, userIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("user_id")
    .eq("org_id", orgId)
    .in("user_id", ids);
  if (error) throw error;
  return new Set((data ?? []).map((m) => m.user_id));
}

/** Rows as the page shows them: with their repositories, by name, and the
 *  login of who each runs as (none for a runner no longer in the org). */
async function withDetails(orgId: string, rows: AutomationRowRead[]): Promise<Automation[]> {
  if (rows.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const links = await supabase
    .from("automation_repos")
    .select("automation_id, project_id")
    .in(
      "automation_id",
      rows.map((r) => r.id),
    );
  if (links.error) throw links.error;
  const projectIds = [...new Set((links.data ?? []).map((l) => l.project_id))];
  const runnerIds = rows.flatMap((r) => (r.runs_as ? [r.runs_as] : []));
  const [projects, runners, members, schedules, used] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id, full_name").in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    people(runnerIds),
    currentRunners(orgId, runnerIds),
    schedulesOf(rows.map((r) => r.id)),
    runsUsed(rows),
  ]);
  if (projects.error) throw projects.error;
  const nameOf = new Map((projects.data ?? []).map((p) => [p.id, p.full_name]));
  const reposOf = new Map<string, AutomationRepo[]>();
  for (const link of links.data ?? []) {
    const fullName = nameOf.get(link.project_id);
    if (!fullName) continue;
    reposOf.set(link.automation_id, [...(reposOf.get(link.automation_id) ?? []), { projectId: link.project_id, fullName }]);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    template: r.template,
    prompt: r.prompt,
    triggers: r.triggers,
    schedules: schedules.get(r.id) ?? [],
    repos: (reposOf.get(r.id) ?? []).sort((a, b) => a.fullName.localeCompare(b.fullName)),
    enabled: r.enabled,
    reviewers: r.reviewers,
    labels: r.labels,
    maxRuns: r.max_runs,
    archiveWhenDone: r.archive_when_done,
    debounceSeconds: r.debounce_seconds,
    sessionMode: r.session_mode,
    coverNewRepos: r.cover_new_repos,
    archived: r.archived_at !== null,
    runsUsed: used.get(r.id) ?? null,
    runsAs: r.runs_as && members.has(r.runs_as) ? { id: r.runs_as, login: runners.get(r.runs_as)?.login ?? "" } : null,
    createdAt: r.created_at,
  }));
}

/** The automations' schedules, each's in order. */
export async function schedulesOf(automationIds: readonly string[]): Promise<Map<string, Schedule[]>> {
  if (automationIds.length === 0) return new Map();
  const { data, error } = await createSupabaseAdminClient()
    .from("automation_schedules")
    .select("automation_id, kind, timezone, spec")
    .in("automation_id", [...automationIds])
    .order("position", { ascending: true });
  if (error) throw error;
  const of = new Map<string, Schedule[]>();
  for (const row of data ?? []) {
    const schedule = scheduleFromRow(row);
    if (schedule) of.set(row.automation_id, [...(of.get(row.automation_id) ?? []), schedule]);
  }
  return of;
}

/** Schedules as they're saved: each with when it fires next from `now`. */
export function scheduleRows(schedules: readonly Schedule[], now = Date.now()) {
  return schedules.map((schedule) => {
    const next = nextRun(schedule, now);
    return {
      kind: schedule.kind,
      timezone: schedule.timezone,
      spec: scheduleSpec(schedule),
      next_run_at: next === null ? null : new Date(next).toISOString(),
    };
  });
}

/** What's given of its filters and limits, as update_automation's settings
 *  name them. */
function limitSettings(change: Partial<AutomationInput>) {
  return {
    ...(change.reviewers !== undefined ? { reviewers: change.reviewers } : {}),
    ...(change.labels !== undefined ? { labels: change.labels } : {}),
    ...(change.maxRuns !== undefined ? { max_runs: change.maxRuns } : {}),
    ...(change.archiveWhenDone !== undefined ? { archive_when_done: change.archiveWhenDone } : {}),
    ...(change.debounceSeconds !== undefined ? { debounce_seconds: change.debounceSeconds } : {}),
    ...(change.sessionMode !== undefined ? { session_mode: change.sessionMode } : {}),
    ...(change.coverNewRepos !== undefined ? { cover_new_repos: change.coverNewRepos } : {}),
    ...(change.archived !== undefined ? { archived: change.archived } : {}),
  };
}

/** An org's automations, oldest first. */
export async function listAutomations(orgId: string): Promise<Automation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return withDetails(orgId, data ?? []);
}

/** One automation of an org, or null. */
export async function getAutomation(orgId: string, automationId: string): Promise<Automation | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("id", automationId)
    .maybeSingle();
  if (error) throw error;
  return data ? ((await withDetails(orgId, [data]))[0] ?? null) : null;
}

/** Thrown when an automation names a repository that isn't the org's. */
export class ForeignRepoError extends Error {
  constructor() {
    super("Pick repositories connected to this org.");
    this.name = "ForeignRepoError";
  }
}

/** Thrown when an automation would have the review requested trigger but
 *  no one's review requests to start on (automations_reviewers_check). */
export class NoReviewersError extends Error {
  constructor() {
    super("Name whose review requests start it, or untick Review requested.");
    this.name = "NoReviewersError";
  }
}

/** Thrown when an automation would cover new repositories with a trigger
 *  that runs on all of them (automations_cover_new_repos_check). */
export class CoverNewReposTriggersError extends Error {
  constructor() {
    super(COVER_NEW_REPOS_TRIGGERS_ERROR);
    this.name = "CoverNewReposTriggersError";
  }
}

/** The database's refusal (`foreign_repo`, SQLSTATE OR001; or one of its
 *  checks) as its error; else the error. */
function refusal(error: { code?: string; message?: string }): Error {
  if (error.code === "OR001") return new ForeignRepoError();
  if (error.code === "23514" && error.message?.includes("automations_reviewers_check")) return new NoReviewersError();
  if (error.code === "23514" && error.message?.includes("automations_cover_new_repos_check")) return new CoverNewReposTriggersError();
  return error as Error;
}

/** Make an automation of `orgId`, run as `runsAs`; answers its id. */
export async function createAutomation(orgId: string, runsAs: string, input: AutomationInput): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().rpc("create_automation", {
    target_org: orgId,
    runner: runsAs,
    automation_name: input.name,
    automation_template: input.template,
    automation_prompt: input.prompt,
    automation_triggers: input.triggers,
    is_enabled: input.enabled,
    project_ids: input.projectIds,
    settings: {
      schedules: scheduleRows(input.schedules),
      ...(input.triggers.includes("webhook") ? { webhook: webhookTokenSettings() } : {}),
      ...limitSettings(input),
    },
  });
  if (error) throw refusal(error);
  return data;
}

/**
 * Change what's given of an automation of `orgId`; false when it has none by
 * that id. Changing what it does (prompt, triggers, schedules, repositories)
 * makes `editor` who it runs as; renaming or switching it doesn't. Its
 * template stays what it was made from. Switched on, its schedules are
 * worked out again from now: it doesn't catch up on what it would have run
 * while off.
 */
export async function updateAutomation(
  orgId: string,
  automationId: string,
  editor: string,
  change: Partial<AutomationInput>,
): Promise<boolean> {
  const schedules = change.schedules ?? (change.enabled === true ? (await schedulesOf([automationId])).get(automationId) : undefined);
  const { data, error } = await createSupabaseAdminClient().rpc("update_automation", {
    target_org: orgId,
    automation: automationId,
    editor,
    automation_name: change.name ?? null,
    automation_prompt: change.prompt ?? null,
    automation_triggers: change.triggers ?? null,
    is_enabled: change.enabled ?? null,
    project_ids: change.projectIds ?? null,
    settings: {
      ...(schedules ? { schedules: scheduleRows(schedules) } : {}),
      // Its first URL, should it have none yet (the database keeps one it has).
      ...(change.triggers?.includes("webhook") ? { webhook: webhookTokenSettings() } : {}),
      ...limitSettings(change),
    },
  });
  if (error) throw refusal(error);
  return data === true;
}

/**
 * The org's Code Review automation, made on `projectIds` (and covering
 * repositories connected after) as `runsAs`, when the org has none from its
 * template in any state: off, archived, or not covering new ones is an
 * admin's choice, kept. Its id, or null when the org had one.
 */
export async function ensureCodeReview(orgId: string, runsAs: string, projectIds: readonly string[]): Promise<string | null> {
  const template = automationTemplate(CODE_REVIEW_TEMPLATE_ID);
  if (!template) throw new Error(`The ${CODE_REVIEW_TEMPLATE_ID} template is missing.`);
  const { data, error } = await createSupabaseAdminClient().rpc("ensure_code_review", {
    target_org: orgId,
    runner: runsAs,
    automation_name: template.name,
    automation_template: template.id,
    automation_prompt: template.prompt,
    automation_triggers: template.triggers,
    project_ids: [...projectIds],
  });
  if (error) throw refusal(error);
  return data;
}

export async function deleteAutomation(orgId: string, automationId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .delete()
    .eq("org_id", orgId)
    .eq("id", automationId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}
