/**
 * The projects a GitHub webhook's repository could be: those of the orgs that
 * own the installation the event came from (org_github_installations). A
 * project's full name is its org's members' to choose, and another org's
 * could be renamed to collide with this repository's — which must not
 * receive its private events. Node-safe, the database client passed in, so
 * this is testable (lib/supabase/server.ts is Next-only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** The projects of `installationId`'s own orgs that are `repoFullName`. */
export async function installationProjectsOf(
  db: SupabaseClient<Database>,
  installationId: number,
  repoFullName: string,
): Promise<{ id: string; org_id: string }[]> {
  const { data: links, error: linksError } = await db
    .from("org_github_installations")
    .select("org_id")
    .eq("installation_id", installationId);
  if (linksError) throw linksError;
  const orgIds = [...new Set((links ?? []).map((l) => l.org_id))];
  if (!orgIds.length) return [];
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id, org_id")
    .in("org_id", orgIds)
    .ilike("full_name", repoFullName.replace(/[\\%_]/g, "\\$&"));
  if (projectsError) throw projectsError;
  return projects ?? [];
}
