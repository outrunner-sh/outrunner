/**
 * Orgs and memberships (supabase/migrations/20261027120000_organizations.sql,
 * 20261028120000_team_orgs.sql). A user reads their own orgs through RLS;
 * making and changing an org is the server's (service role), so each writer
 * here is handed the checks the route made and checks the role itself.
 */

import { type Org, type OrgRole, sortOrgs } from "@/lib/orgs/active";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** The signed-in user's orgs, personal first, with their role in each; none
 *  before the migration that adds orgs. */
export async function listMyOrgs(): Promise<Org[]> {
  const supabase = await createSupabaseServerClient();
  // RLS: their own memberships, and the orgs they're a member of. One read:
  // every page's sidebar waits on it before its own.
  const { data: memberships, error } = await supabase
    .from("organization_members")
    .select("org_id, role, organizations(id, name, personal_owner_id)");
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  if (!memberships?.length) return [];
  return sortOrgs(
    memberships.flatMap((m) => {
      const o = m.organizations;
      return o
        ? [{ id: o.id, name: o.name, personal: o.personal_owner_id !== null, role: (m.role as OrgRole) ?? "member" }]
        : [];
    }),
  );
}

/** Whether a project's org has members besides `userId`: someone else may
 *  hold what the user can't see. False for a project the user can't see. */
export async function orgHasOtherMembers(projectId: string, userId: string): Promise<boolean> {
  // As the user: RLS says whether they can see the project at all.
  const { data: project, error } = await (await createSupabaseServerClient())
    .from("projects")
    .select("org_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!project) return false;
  // As the server: a member reads only their own membership row.
  const { count, error: countError } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", project.org_id)
    .neq("user_id", userId);
  if (countError) throw countError;
  return (count ?? 0) > 0;
}

/** A user's personal org, read as the server; null before it's made. */
export async function personalOrgId(userId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .select("id")
    .eq("personal_owner_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** The personal orgs among `orgIds`, by org, with their owners. */
export async function personalOwners(orgIds: readonly string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data, error } = await createSupabaseAdminClient()
      .from("organizations")
      .select("id, personal_owner_id")
      .in("id", orgIds.slice(i, i + 200))
      .not("personal_owner_id", "is", null);
    if (error) throw error;
    for (const row of data) if (row.personal_owner_id) owners.set(row.id, row.personal_owner_id);
  }
  return owners;
}

/** An org's name and kind, read as the server; null for no such org. */
export async function getOrg(orgId: string): Promise<{ id: string; name: string; personal: boolean } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .select("id, name, personal_owner_id")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, name: data.name, personal: data.personal_owner_id !== null } : null;
}

/** A user's role in an org, or null when they aren't a member. */
export async function memberRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as OrgRole | undefined) ?? null;
}

/** An org that has claimed a domain, as someone asking to make another sees it. */
export type DomainOrg = { id: string; name: string; domain: string; memberCount: number };

/** The orgs that have claimed any of these domains and still have people (its
 *  connector isn't one). One with none left holds its domain for no one: the
 *  next org made for it takes it over (20261118120000_abandoned_org_domains.sql). */
export async function orgsForDomains(domains: readonly string[]): Promise<DomainOrg[]> {
  if (domains.length === 0) return [];
  const { data, error } = await createSupabaseAdminClient().rpc("domain_orgs", { domains: [...domains] });
  if (error) throw error;
  return (data ?? []).map((o) => ({ id: o.id, name: o.name, domain: o.domain, memberCount: Number(o.member_count) }));
}

/** The domain an org claimed, if it did. */
export async function orgDomain(orgId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_domains")
    .select("domain")
    .eq("org_id", orgId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.domain ?? null;
}

/** Why a team org wasn't made. */
export class TeamOrgError extends Error {
  constructor(readonly reason: "one_team_org" | "domain_taken") {
    super(
      reason === "one_team_org"
        ? "You've made a team org already. For now each person can make one."
        : "Another org has claimed your email's domain.",
    );
    this.name = "TeamOrgError";
  }
}

/**
 * Make a team org with its creator as admin, claiming `domain` (a verified,
 * non-public one: the caller checked) or none. All or nothing.
 */
export async function createTeamOrg(input: { name: string; creatorId: string; domain: string | null }): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().rpc("create_team_org", {
    org_name: input.name,
    creator: input.creatorId,
    claimed_domain: input.domain,
  });
  // Which unique index refused it, by name (20261028120000_team_orgs.sql);
  // any other stays the error it is.
  if (error?.code === "23505") {
    const text = `${error.message} ${error.details ?? ""}`;
    if (text.includes("organization_domains_pkey")) throw new TeamOrgError("domain_taken");
    if (text.includes("organizations_one_team_org_per_creator")) throw new TeamOrgError("one_team_org");
  }
  if (error) throw error;
  if (typeof data !== "string") throw new Error("create_team_org returned no org.");
  return data;
}

/** Rename an org; its admins may, and a personal org keeps its name. */
export async function renameOrg(orgId: string, userId: string, name: string): Promise<boolean> {
  if ((await memberRole(orgId, userId)) !== "admin") return false;
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .update({ name })
    .eq("id", orgId)
    .is("personal_owner_id", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
