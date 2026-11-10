/**
 * The automations' side of a GitHub pull request event, on the installation's
 * own orgs' projects of the repository only (installation-projects.ts: by
 * GitHub's repository id, never the full name a project's write-level members
 * can set, so another org's project renamed to collide with the repository
 * gets none of its events). Split from lib/db/automation-runs.ts, the database
 * client passed in, so this is testable in Node (that module reaches the
 * Next-only supabase server client).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { installationProjectsOf } from "@/lib/db/installation-projects";
import type { Database } from "@/lib/supabase/database.types";

type Db = SupabaseClient<Database>;

/** The linked orgs and their projects of the repository `repoId`; null when
 *  there are none. */
async function installationProjects(db: Db, installationId: number, repoId: number): Promise<{ orgIds: string[]; projectIds: string[] } | null> {
  const { orgIds, projects } = await installationProjectsOf(db, installationId, repoId);
  const projectIds = projects.map((p) => p.id);
  return projectIds.length === 0 ? null : { orgIds, projectIds };
}

/** The automations on the repository, as each one's links to its projects,
 *  in the orgs linked to the installation (automationsForPullRequest makes
 *  them candidates). */
export async function pullRequestAutomationLinksWith(
  db: Db,
  installationId: number,
  repoId: number,
): Promise<{ orgIds: string[]; links: { automation_id: string; project_id: string }[] }> {
  const scope = await installationProjects(db, installationId, repoId);
  if (!scope) return { orgIds: [], links: [] };
  const { data: repos, error } = await db.from("automation_repos").select("automation_id, project_id").in("project_id", scope.projectIds);
  if (error) throw error;
  return { orgIds: scope.orgIds, links: repos ?? [] };
}

/**
 * The open sessions of the automations' runs on a pull request, by their
 * owner (the runner each was started as), for it closing to archive them.
 */
export async function pullRequestSessionsWith(db: Db, installationId: number, repoId: number, prNumber: number): Promise<Map<string, string[]>> {
  const scope = await installationProjects(db, installationId, repoId);
  if (!scope) return new Map();
  const { data: runs, error } = await db
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
  const { data: sessions, error: sessionsError } = await db.from("workspaces").select("id, owner_id").in("id", ids).in("status", ["ready", "idle"]);
  if (sessionsError) throw sessionsError;
  const byOwner = new Map<string, string[]>();
  for (const s of sessions ?? []) byOwner.set(s.owner_id, [...(byOwner.get(s.owner_id) ?? []), s.id]);
  return byOwner;
}

/** The runs on a pull request whose check is still open, with no review in. */
export async function openChecksOfPullRequestWith(db: Db, installationId: number, repoId: number, prNumber: number): Promise<string[]> {
  const scope = await installationProjects(db, installationId, repoId);
  if (!scope) return [];
  const { data, error } = await db
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
