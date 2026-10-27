/**
 * Orgs and memberships (supabase/migrations/20261027120000_organizations.sql,
 * 20261028120000_team_orgs.sql). A user reads their own orgs through RLS;
 * making and changing an org is the server's (service role), so each writer
 * here is handed the checks the route made and checks the role itself.
 */

import { type Org, type OrgRole, sortOrgs } from "@/lib/orgs/active";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** The signed-in user's orgs, personal first, with their role in each. */
export async function listMyOrgs(): Promise<Org[]> {
  const supabase = await createSupabaseServerClient();
  // RLS: their own memberships, and the orgs they're a member of.
  const { data: memberships, error } = await supabase.from("organization_members").select("org_id, role");
  if (error) throw error;
  if (!memberships?.length) return [];
  const { data: orgs, error: orgsError } = await supabase
    .from("organizations")
    .select("id, name, personal_owner_id")
    .in(
      "id",
      memberships.map((m) => m.org_id),
    );
  if (orgsError) throw orgsError;
  const roles = new Map(memberships.map((m) => [m.org_id, m.role as OrgRole]));
  return sortOrgs(
    (orgs ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      personal: o.personal_owner_id !== null,
      role: roles.get(o.id) ?? "member",
    })),
  );
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

/** The orgs that have claimed any of these domains. */
export async function orgsForDomains(domains: readonly string[]): Promise<DomainOrg[]> {
  if (domains.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const { data: claims, error } = await supabase
    .from("organization_domains")
    .select("domain, org_id")
    .in("domain", [...domains]);
  if (error) throw error;
  const found: DomainOrg[] = [];
  for (const claim of claims ?? []) {
    const [{ data: org, error: orgError }, { count, error: countError }] = await Promise.all([
      supabase.from("organizations").select("id, name").eq("id", claim.org_id).maybeSingle(),
      supabase.from("organization_members").select("user_id", { count: "exact", head: true }).eq("org_id", claim.org_id),
    ]);
    if (orgError) throw orgError;
    if (countError) throw countError;
    if (org) found.push({ id: org.id, name: org.name, domain: claim.domain, memberCount: count ?? 0 });
  }
  return found;
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
  if (error?.code === "23505") {
    throw new TeamOrgError(
      `${error.message} ${error.details ?? ""}`.includes("organization_domains") ? "domain_taken" : "one_team_org",
    );
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
