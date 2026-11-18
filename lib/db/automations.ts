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
  type AutomationModel,
  type AutomationRepo,
  type AutomationTarget,
  type AutomationTrigger,
  COVER_NEW_REPOS_TRIGGERS_ERROR,
} from "@/lib/automations/rules";
import { seal } from "@/lib/crypto/secret-box";
import { nextRun, type Schedule, scheduleFromRow, scheduleSpec } from "@/lib/automations/schedule";
import { automationTemplate, CODE_REVIEW_TEMPLATE_ID } from "@/lib/automations/templates";
import { webhookTokenSettings } from "@/lib/db/automation-webhooks";
import { people } from "@/lib/db/org-members";
import type { Json } from "@/lib/supabase/database.types";
import { recordedModel } from "@/lib/runtime/session-models";
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
  model_provider: string | null;
  model_id: string | null;
  model_effort: string | null;
  archived_at: string | null;
  runs_since: string;
  created_at: string;
  target_kind: "session" | "mission";
  target_mission_id: string | null;
  watch_team_id: string | null;
  watch_channel_id: string | null;
  filter_prompt: string | null;
  allowed_app_ids: string[];
  linear_team_ids: string[];
  webhook_hmac_sealed: string | null;
};

const COLUMNS =
  "id, name, template, prompt, triggers, enabled, runs_as, reviewers, labels, max_runs, archive_when_done, debounce_seconds, session_mode, cover_new_repos, model_provider, model_id, model_effort, archived_at, runs_since, created_at, target_kind, target_mission_id, watch_team_id, watch_channel_id, filter_prompt, allowed_app_ids, linear_team_ids, webhook_hmac_sealed";

/** Where a row's runs go, as the page shows it. */
function targetOf(r: AutomationRowRead, missions: MissionsOf): AutomationTarget {
  if (r.target_kind !== "mission" || !r.target_mission_id) return { kind: "session" };
  return {
    kind: "mission",
    missionId: r.target_mission_id,
    missionTitle: missions.titles.get(r.target_mission_id) ?? null,
    approved: missions.approved.has(r.id),
    hasHmacSecret: r.webhook_hmac_sealed !== null,
    watch:
      r.watch_team_id && r.watch_channel_id && r.filter_prompt
        ? { teamId: r.watch_team_id, channelId: r.watch_channel_id, filterPrompt: r.filter_prompt, allowedAppIds: r.allowed_app_ids }
        : null,
    linearTeamIds: r.linear_team_ids,
  };
}

type MissionsOf = { titles: Map<string, string | null>; approved: Set<string> };

/** The Missions these rows go to (each's name), and which of the rows their
 *  owner has approved sending it work (mission_delegations). */
async function missionsOf(rows: readonly AutomationRowRead[]): Promise<MissionsOf> {
  const targeted = rows.filter((r) => r.target_mission_id);
  if (targeted.length === 0) return { titles: new Map(), approved: new Set() };
  const supabase = createSupabaseAdminClient();
  const missionIds = [...new Set(targeted.map((r) => r.target_mission_id as string))];
  const [missions, delegations] = await Promise.all([
    supabase.from("workspaces").select("id, title, owner_id").in("id", missionIds),
    supabase.from("mission_delegations").select("automation_id, approved_by, approved_at, revoked_at").in("automation_id", targeted.map((r) => r.id)),
  ]);
  if (missions.error) throw missions.error;
  if (delegations.error) throw delegations.error;
  const missionOf = new Map((missions.data ?? []).map((m) => [m.id, m]));
  const delegationOf = new Map((delegations.data ?? []).map((d) => [d.automation_id, d]));
  const approved = new Set<string>();
  for (const r of targeted) {
    const owner = missionOf.get(r.target_mission_id as string)?.owner_id;
    const d = delegationOf.get(r.id);
    if (owner && d?.approved_at && !d.revoked_at && d.approved_by === owner) approved.add(r.id);
  }
  return { titles: new Map((missions.data ?? []).map((m) => [m.id, m.title])), approved };
}

/** A row's model (model_provider, model_id, model_effort), checked as a
 *  session's request is: null with none, or one this release no longer
 *  offers (it runs as the org set its automations to). */
export function modelFromRow(row: { model_provider: string | null; model_id: string | null; model_effort: string | null }): AutomationModel | null {
  if (!row.model_provider || !row.model_id) return null;
  const recorded = recordedModel(row.model_provider, row.model_id, row.model_effort);
  return recorded ? { provider: recorded.model.provider, id: recorded.model.id, effort: recorded.effort } : null;
}

/** An automation's model as create_automation and update_automation take
 *  it (`settings.model`): null clears it. */
export function modelSetting(model: AutomationModel | null): { provider: string; id: string; effort: string | null } | null {
  return model ? { provider: model.provider, id: model.id, effort: model.effort } : null;
}

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
  const [projects, runners, members, schedules, used, missions] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id, full_name").in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    people(runnerIds),
    currentRunners(orgId, runnerIds),
    schedulesOf(rows.map((r) => r.id)),
    runsUsed(rows),
    missionsOf(rows),
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
    model: modelFromRow(r),
    archived: r.archived_at !== null,
    runsUsed: used.get(r.id) ?? null,
    runsAs: r.runs_as && members.has(r.runs_as) ? { id: r.runs_as, login: runners.get(r.runs_as)?.login ?? "" } : null,
    target: targetOf(r, missions),
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

/** What's given of its filters, limits and model, as update_automation's
 *  settings name them. */
function limitSettings(change: Partial<AutomationInput>) {
  return {
    ...(change.reviewers !== undefined ? { reviewers: change.reviewers } : {}),
    ...(change.labels !== undefined ? { labels: change.labels } : {}),
    ...(change.maxRuns !== undefined ? { max_runs: change.maxRuns } : {}),
    ...(change.archiveWhenDone !== undefined ? { archive_when_done: change.archiveWhenDone } : {}),
    ...(change.debounceSeconds !== undefined ? { debounce_seconds: change.debounceSeconds } : {}),
    ...(change.sessionMode !== undefined ? { session_mode: change.sessionMode } : {}),
    ...(change.coverNewRepos !== undefined ? { cover_new_repos: change.coverNewRepos } : {}),
    ...(change.model !== undefined ? { model: modelSetting(change.model) } : {}),
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

/** A Mission automation's inputs, as set_mission_automation_inputs and
 *  create_mission_automation name them: what's given. */
function missionInputs(change: Partial<AutomationInput>): Record<string, unknown> {
  const target = change.target?.kind === "mission" ? change.target : null;
  return {
    ...(target && { mission_id: target.missionId }),
    ...(target?.watch && {
      watch_team_id: target.watch.teamId,
      watch_channel_id: target.watch.channelId,
      filter_prompt: target.watch.filterPrompt,
      allowed_app_ids: target.watch.allowedAppIds,
    }),
    ...(target && { linear_team_ids: target.linearTeamIds }),
    ...(change.webhookSecret !== undefined && { webhook_hmac_sealed: change.webhookSecret === null ? null : seal(change.webhookSecret) }),
  };
}

/** Make an automation of `orgId`, run as `runsAs`; answers its id. A
 *  Mission's is made with its target and inputs at once. */
export async function createAutomation(orgId: string, runsAs: string, input: AutomationInput): Promise<string> {
  if (input.target?.kind === "mission") {
    const { data, error } = await createSupabaseAdminClient().rpc("create_mission_automation", {
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
      inputs: missionInputs(input) as Json,
    });
    if (error) throw refusal(error);
    return data;
  }
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
  // A Mission's inputs first: a trigger turned on below may need them. An
  // empty list of Linear teams goes last, once the Linear trigger is off
  // (automations_inputs_check: the trigger needs a team while it's on).
  const inputs = missionInputs(change);
  delete inputs.mission_id;
  const clearsTeams = Array.isArray(inputs.linear_team_ids) && inputs.linear_team_ids.length === 0;
  if (clearsTeams) delete inputs.linear_team_ids;
  if (Object.keys(inputs).length > 0) {
    const { error } = await createSupabaseAdminClient().rpc("set_mission_automation_inputs", { target_org: orgId, automation: automationId, inputs: inputs as Json });
    if (error) throw refusal(error);
  }
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
  if (data === true && clearsTeams) {
    const { error: teamsError } = await createSupabaseAdminClient().rpc("set_mission_automation_inputs", {
      target_org: orgId,
      automation: automationId,
      inputs: { linear_team_ids: [] },
    });
    if (teamsError) throw refusal(teamsError);
  }
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

/** A Mission automation's delegation: its owner's approval to send it
 *  work unattended. Approved at once when its owner makes it. */
export async function requestDelegation(automationId: string, missionId: string, requestedBy: string, ownerApproves: boolean): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await createSupabaseAdminClient()
    .from("mission_delegations")
    .upsert(
      {
        automation_id: automationId,
        mission_id: missionId,
        requested_by: requestedBy,
        approved_by: ownerApproves ? requestedBy : null,
        approved_at: ownerApproves ? now : null,
        revoked_at: null,
      },
      { onConflict: "automation_id" },
    );
  if (error) throw error;
}

/** The Mission's owner approves (or revokes) an automation sending it work.
 *  Approving makes its row if a failed write left none. */
export async function setDelegation(automationId: string, missionId: string, ownerId: string, approve: boolean): Promise<boolean> {
  const now = new Date().toISOString();
  const db = createSupabaseAdminClient();
  if (approve) {
    const { data, error } = await db
      .from("mission_delegations")
      .upsert(
        { automation_id: automationId, mission_id: missionId, approved_by: ownerId, approved_at: now, revoked_at: null },
        { onConflict: "automation_id" },
      )
      .select("automation_id, mission_id");
    if (error) throw error;
    return (data ?? []).some((d) => d.mission_id === missionId);
  }
  const { data, error } = await db
    .from("mission_delegations")
    .update({ revoked_at: now })
    .eq("automation_id", automationId)
    .eq("mission_id", missionId)
    .select("automation_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** A change by someone other than the Mission's owner to what an automation
 *  sends it: its approval is withdrawn until the owner approves again. */
export async function resetDelegation(automationId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("mission_delegations")
    .update({ approved_by: null, approved_at: null })
    .eq("automation_id", automationId);
  if (error) throw error;
}

/** Whether a Mission's owner has approved this automation sending it work,
 *  and still does. */
export async function delegationApproved(automationId: string, mission: { id: string; ownerId: string }): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("mission_delegations")
    .select("approved_by, approved_at, revoked_at, mission_id")
    .eq("automation_id", automationId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data && data.mission_id === mission.id && data.approved_at && !data.revoked_at && data.approved_by === mission.ownerId);
}

/** The automations sending work to a Mission, for its Triggers view. */
export async function missionAutomations(orgId: string, missionId: string): Promise<Automation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("automations")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("target_mission_id", missionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return withDetails(orgId, data ?? []);
}

/** The org's Missions an automation can send its runs to: live ones, by
 *  name (the routes check write on each's project). */
export async function orgMissionChoices(orgId: string): Promise<{ id: string; title: string; projectId: string }[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .select("id, title, project_id, created_at")
    .eq("org_id", orgId)
    .eq("kind", "mission")
    .not("status", "in", "(archiving,archived,destroying,destroyed,failed)")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((m) => ({ id: m.id, title: m.title ?? "Mission", projectId: m.project_id }));
}
