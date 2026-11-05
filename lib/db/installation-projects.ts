/**
 * The projects a GitHub webhook's repository could be: those of the orgs
 * that own the installation the event came from, while the installation is
 * live (org_github_installation_details). The single implementation of the
 * lookup — lib/db/github-loop.ts and lib/db/automation-runs.ts delegate
 * here. Matched by GitHub's repository id, never by full name: a project's
 * full name is its org's members' to choose, and another org's could be
 * renamed to collide with this repository's — which must not receive its
 * private events. Node-safe, the database client passed in, so
 * this is testable (lib/supabase/server.ts is Next-only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** What an installation's orgs are, and which of their projects are a
 *  repository. */
export type InstallationProjectsScope = {
  /** Every org linked to the installation, while it is not suspended. */
  orgIds: string[];
  /** Those orgs' projects of the repository `repoId`: GitHub itself assigns
   *  `github_repo_id`, and it stays what it is through a rename, unlike a
   *  project's full name, which a write-level member can set. Never matched
   *  by name: every event that gets here (`pull_request*`, `issues`,
   *  `check_*`, `status`, …) carries `repository.id`, so the id is required,
   *  and a caller can't forget it. */
  projects: { id: string; org_id: string }[];
};

/** The orgs linked to the installation, while it is not suspended. */
export async function installationOrgsOf(db: SupabaseClient<Database>, installationId: number): Promise<string[]> {
  const { data: holders, error } = await db
    .from("org_github_installation_details")
    .select("org_id")
    .eq("installation_id", installationId)
    .is("suspended_at", null);
  if (error) throw error;
  return [...new Set((holders ?? []).map((h) => h.org_id))];
}

export async function installationProjectsOf(
  db: SupabaseClient<Database>,
  installationId: number,
  repoId: number,
): Promise<InstallationProjectsScope> {
  const orgIds = await installationOrgsOf(db, installationId);
  if (orgIds.length === 0) return { orgIds, projects: [] };
  const { data, error } = await db.from("projects").select("id, org_id").in("org_id", orgIds).eq("github_repo_id", repoId);
  if (error) throw error;
  return { orgIds, projects: data ?? [] };
}

/** GitHub's id of a webhook's repository (`repository.id`), or of a pull
 *  request's base (`pull_request.base.repo.id`); null when it names none,
 *  which reaches no project. */
export function repositoryIdOf(payload: unknown): number | null {
  const p = (payload ?? {}) as { repository?: { id?: unknown } | null; pull_request?: { base?: { repo?: { id?: unknown } | null } | null } | null };
  const id = p.repository?.id ?? p.pull_request?.base?.repo?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}
