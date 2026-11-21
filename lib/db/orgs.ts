/**
 * Orgs and memberships (supabase/migrations/20261027120000_organizations.sql,
 * 20261028120000_team_orgs.sql). A user reads their own orgs through RLS;
 * making and changing an org is the server's (service role), so each writer
 * here is handed the checks the route made and checks the role itself.
 */

import type { User } from "@supabase/supabase-js";

import { ownerFromUser } from "@/lib/auth/owner";
import { type Org, type OrgRole, sortOrgs } from "@/lib/orgs/active";
import { ownOrgName, pickOwnOrg } from "@/lib/orgs/own-org";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** The signed-in user's orgs, by name, with their role in each and when they
 *  joined; none before the migration that adds orgs. */
export async function listMyOrgs(): Promise<Org[]> {
  const supabase = await createSupabaseServerClient();
  // RLS: their own memberships, and the orgs they're a member of. One read:
  // every page's sidebar waits on it before its own.
  const { data: memberships, error } = await supabase
    .from("organization_members")
    .select("org_id, role, created_at, organizations(id, name)");
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  if (!memberships?.length) return [];
  return sortOrgs(
    memberships.flatMap((m) => {
      const o = m.organizations;
      return o
        ? [{ id: o.id, name: o.name, joinedAt: m.created_at, role: (m.role as OrgRole) ?? "member" }]
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

/**
 * A user's own org, read as the server: the first org they made and still
 * administer (the one made for them at sign-in: lib/orgs/own-org.ts, or the
 * personal org their account came with). Null when there's none.
 */
export async function ownOrgId(userId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .select("id, created_at, organization_members!inner(user_id, role)")
    .eq("created_by", userId)
    .eq("organization_members.user_id", userId)
    .eq("organization_members.role", "admin");
  if (error) throw error;
  return pickOwnOrg(
    (data ?? []).map((o) => ({ id: o.id, createdAt: o.created_at })),
  );
}

/** An org's name, read as the server; null for no such org. */
export async function getOrg(orgId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, name: data.name } : null;
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

/** Why an org wasn't made. */
export class TeamOrgError extends Error {
  constructor(readonly reason: "one_free_org" | "domain_taken") {
    super(
      reason === "one_free_org"
        ? "You've made a Free org already. Upgrade an org you're an admin of to make another."
        : "Another org has claimed your email's domain.",
    );
    this.name = "TeamOrgError";
  }
}

/**
 * Make an org with its creator as admin, claiming `domain` (a verified,
 * non-public one: the caller checked) or none. All or nothing. Refused with
 * `one_free_org` when they've made one already and `mayMakeAnother` is false
 * (lib/orgs/create.ts says).
 */
export async function createTeamOrg(input: {
  name: string;
  creatorId: string;
  domain: string | null;
  mayMakeAnother: boolean;
}): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().rpc("create_team_org", {
    org_name: input.name,
    creator: input.creatorId,
    claimed_domain: input.domain,
    may_make_another: input.mayMakeAnother,
  });
  // Which rule refused it, by name (20261028120000_team_orgs.sql,
  // 20261120130000_own_org_on_sign_in.sql); any other stays the error it is.
  if (error?.code === "23505" && `${error.message} ${error.details ?? ""}`.includes("organization_domains_pkey")) {
    throw new TeamOrgError("domain_taken");
  }
  if (error?.code === "23514" && error.message.includes("one_free_org")) throw new TeamOrgError("one_free_org");
  if (error) throw error;
  if (typeof data !== "string") throw new Error("create_team_org returned no org.");
  return data;
}

/**
 * Make the user's own org (lib/orgs/own-org.ts), named after them, with them
 * its admin, if they're in no org (20261120130000_own_org_on_sign_in.sql):
 * its id, or null when they're in one already, and none was made.
 */
export async function createOwnOrg(user: User): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient().rpc("create_own_org", {
    org_name: ownOrgName(ownerFromUser(user).name),
    creator: user.id,
  });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

/** Rename an org; its admins may. */
export async function renameOrg(orgId: string, userId: string, name: string): Promise<boolean> {
  if ((await memberRole(orgId, userId)) !== "admin") return false;
  const { data, error } = await createSupabaseAdminClient()
    .from("organizations")
    .update({ name })
    .eq("id", orgId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
