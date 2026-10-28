/**
 * An org's automations (supabase/migrations/20261030130000_automations.sql).
 * The tables are the server's alone, so this reaches them with the service
 * role; the routes calling it check who may (the org's admins change them,
 * every member reads them). Making and changing one each go through a
 * database function: one transaction, which checks the repositories are the
 * org's.
 */

import type { Automation, AutomationInput, AutomationRepo, AutomationTrigger } from "@/lib/automations/rules";
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
  created_at: string;
};

const COLUMNS = "id, name, template, prompt, triggers, enabled, runs_as, created_at";

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
  const [projects, runners, members] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id, full_name").in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    people(runnerIds),
    currentRunners(orgId, runnerIds),
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
    repos: (reposOf.get(r.id) ?? []).sort((a, b) => a.fullName.localeCompare(b.fullName)),
    enabled: r.enabled,
    runsAs: r.runs_as && members.has(r.runs_as) ? { id: r.runs_as, login: runners.get(r.runs_as)?.login ?? "" } : null,
    createdAt: r.created_at,
  }));
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

/** The database's refusal (`foreign_repo`, SQLSTATE OR001) as its error;
 *  else the error. */
function refusal(error: { code?: string }): Error {
  return error.code === "OR001" ? new ForeignRepoError() : (error as Error);
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
  });
  if (error) throw refusal(error);
  return data;
}

/**
 * Change what's given of an automation of `orgId`; false when it has none by
 * that id. Changing what it does (prompt, triggers, repositories) makes
 * `editor` who it runs as; renaming or switching it doesn't. Its template
 * stays what it was made from.
 */
export async function updateAutomation(
  orgId: string,
  automationId: string,
  editor: string,
  change: Partial<AutomationInput>,
): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().rpc("update_automation", {
    target_org: orgId,
    automation: automationId,
    editor,
    automation_name: change.name ?? null,
    automation_prompt: change.prompt ?? null,
    automation_triggers: change.triggers ?? null,
    is_enabled: change.enabled ?? null,
    project_ids: change.projectIds ?? null,
  });
  if (error) throw refusal(error);
  return data === true;
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
