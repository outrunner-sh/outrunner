/**
 * The sessions a pull request announcement goes to: those on its head branch
 * that work in its repository, of the installation's own orgs' projects of
 * it only (installation-projects.ts: another org's project renamed to
 *  collide with the repository must not have its sessions told of it). Split
 * from announce-pull-request.deps.ts, the database client passed in, so this
 * is testable in Node — deps.ts wires the real one.
 */

import { installationProjectsOf } from "@/lib/db/installation-projects";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The sessions on `headRef` that work in the repository: as their own, or
 *  as another of a session of several's. Both queries stay within the
 *  matched projects' orgs, as recordPullRequestEventWith's do: never every
 *  org's sessions on a branch. */
export async function sessionsOnRepoWith(
  db: SupabaseClient<Database>,
  installationId: number,
  repoFullName: string,
  headRef: string,
  repoId?: number,
): Promise<string[]> {
  const { projects } = await installationProjectsOf(db, installationId, repoFullName, repoId);
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const orgIds = [...new Set(projects.map((p) => p.org_id))];
  const queries = [
    db.from("workspaces").select("id").eq("branch", headRef).in("org_id", orgIds).in("project_id", ids),
    ...ids.map((id) => db.from("workspaces").select("id").eq("branch", headRef).in("org_id", orgIds).contains("checkouts", [{ projectId: id }])),
  ];
  const found = new Set<string>();
  for (const { data, error } of await Promise.all(queries)) {
    if (error) throw error;
    for (const session of data ?? []) found.add(session.id);
  }
  return [...found];
}
