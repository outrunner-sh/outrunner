/**
 * The projects a GitHub webhook's repository could be: those of the orgs
 * that own the installation the event came from, while the installation is
 * live (org_github_installation_details). The single implementation of the
 * lookup — lib/db/github-loop.ts and lib/db/automation-runs.ts delegate
 * here. A project's full name is its org's members' to choose, and another
 * org's could be renamed to collide with this repository's — which must not
 * receive its private events. Node-safe, the database client passed in, so
 * this is testable (lib/supabase/server.ts is Next-only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** What an installation's orgs are, and which of their projects are a
 *  repository. */
export type InstallationProjectsScope = {
  /** Every org linked to the installation, while it is not suspended. */
  orgIds: string[];
  /** Those orgs' projects that are `repoFullName` — GitHub's repository of
   *  it when the event names one: GitHub itself assigns `github_repo_id`,
   *  and it stays what it is through a rename, unlike a project's full
   *  name, which a write-level member can set. Only an event that names no
   *  repository id falls back to the full name. */
  projects: { id: string; org_id: string }[];
};

export async function installationProjectsOf(
  db: SupabaseClient<Database>,
  installationId: number,
  repoFullName: string,
  repoId?: number,
): Promise<InstallationProjectsScope> {
  const { data: holders, error: holdersError } = await db
    .from("org_github_installation_details")
    .select("org_id")
    .eq("installation_id", installationId)
    .is("suspended_at", null);
  if (holdersError) throw holdersError;
  const orgIds = [...new Set((holders ?? []).map((h) => h.org_id))];
  if (orgIds.length === 0) return { orgIds, projects: [] };
  const byOrg = db.from("projects").select("id, org_id").in("org_id", orgIds);
  const matched = typeof repoId === "number" ? await byOrg.eq("github_repo_id", repoId) : await byOrg.ilike("full_name", repoFullName.replace(/[\\%_]/g, "\\$&"));
  if (matched.error) throw matched.error;
  return { orgIds, projects: matched.data ?? [] };
}
