/**
 * Roles and access (supabase/migrations/20261028150000_org_access.sql): what
 * a member may do with an org's projects, and the roles and grants an admin
 * sets it with. The tables and the level functions are the server's alone
 * (service role); the routes calling the writers here have checked the
 * caller is an admin (lib/orgs/routes.ts).
 */

import type { AccessLevel, Grant } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** `userId`'s level on a project (a `projects` row): null for none, or for a
 *  project that isn't in one of their orgs. */
export async function projectLevel(userId: string, projectId: string): Promise<AccessLevel | null> {
  const { data, error } = await createSupabaseAdminClient().rpc("project_level", {
    member: userId,
    target_project: projectId,
  });
  if (error) throw error;
  return (data as AccessLevel | null) ?? null;
}

/** `userId`'s level on an org's projects as a whole (connecting new ones
 *  needs write). */
export async function orgProjectsLevel(userId: string, orgId: string): Promise<AccessLevel | null> {
  const { data, error } = await createSupabaseAdminClient().rpc("org_projects_level", {
    member: userId,
    target_org: orgId,
  });
  if (error) throw error;
  return (data as AccessLevel | null) ?? null;
}

/** `userId`'s level on a project's settings (an `environments` row): the
 *  lowest they have on its repositories. */
export async function environmentLevel(userId: string, environmentId: string): Promise<AccessLevel | null> {
  const { data, error } = await createSupabaseAdminClient().rpc("environment_level", {
    member: userId,
    target_environment: environmentId,
  });
  if (error) throw error;
  return (data as AccessLevel | null) ?? null;
}

export type OrgRoleInfo = { id: string; name: string; memberIds: string[] };

/** An org's roles, by name, with who holds each. */
export async function listRoles(orgId: string): Promise<OrgRoleInfo[]> {
  const supabase = createSupabaseAdminClient();
  const [{ data: roles, error }, { data: held, error: heldError }] = await Promise.all([
    supabase.from("organization_roles").select("id, name").eq("org_id", orgId).order("name"),
    supabase.from("member_roles").select("user_id, role_id").eq("org_id", orgId),
  ]);
  if (error) throw error;
  if (heldError) throw heldError;
  return (roles ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    memberIds: (held ?? []).filter((h) => h.role_id === r.id).map((h) => h.user_id),
  }));
}

/** Why a change to roles or grants was refused. */
export class AccessChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessChangeError";
  }
}

/** Make a role. */
export async function createRole(orgId: string, name: string): Promise<OrgRoleInfo> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_roles")
    .insert({ org_id: orgId, name })
    .select("id, name")
    .single();
  if (error?.code === "23505") throw new AccessChangeError(`There's a role called ${name} already.`);
  if (error) throw error;
  return { id: data.id, name: data.name, memberIds: [] };
}

/** Rename a role; false when the org has no such role. */
export async function renameRole(orgId: string, roleId: string, name: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_roles")
    .update({ name })
    .eq("org_id", orgId)
    .eq("id", roleId)
    .select("id");
  if (error?.code === "23505") throw new AccessChangeError(`There's a role called ${name} already.`);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Delete a role, its grants and who held it; false when there's none. */
export async function deleteRole(orgId: string, roleId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_roles")
    .delete()
    .eq("org_id", orgId)
    .eq("id", roleId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Give a member exactly these roles. An admin holds none: they have write on
 * everything already, so a role would only mislead when they're made a member
 * again.
 */
export async function setMemberRoles(orgId: string, userId: string, roleIds: readonly string[]): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new AccessChangeError("They aren't a member of this org.");
  if (member.role === "admin" && roleIds.length > 0) {
    throw new AccessChangeError("Admins can do everything already: roles are for members.");
  }
  const { error: deleteError } = await supabase.from("member_roles").delete().eq("org_id", orgId).eq("user_id", userId);
  if (deleteError) throw deleteError;
  if (roleIds.length === 0) return;
  const { error } = await supabase
    .from("member_roles")
    .insert([...new Set(roleIds)].map((roleId) => ({ org_id: orgId, user_id: userId, role_id: roleId })));
  // A role id from another org, or one deleted meanwhile.
  if (error?.code === "23503") throw new AccessChangeError("One of those roles isn't this org's.");
  if (error) throw error;
}

/** An org's grants. */
export async function listGrants(orgId: string): Promise<Grant[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("access_grants")
    .select("role_id, project_id, level")
    .eq("org_id", orgId);
  if (error) throw error;
  return (data ?? []).map((g) => ({ roleId: g.role_id, projectId: g.project_id, level: g.level as AccessLevel }));
}

/**
 * Set what Everyone (roleId null) or a role gets on all projects (projectId
 * null) or one: `level`, or nothing (null).
 */
export async function setGrant(
  orgId: string,
  grant: { roleId: string | null; projectId: string | null; level: AccessLevel | null },
): Promise<void> {
  const supabase = createSupabaseAdminClient();
  let remove = supabase.from("access_grants").delete().eq("org_id", orgId);
  remove = grant.roleId ? remove.eq("role_id", grant.roleId) : remove.is("role_id", null);
  remove = grant.projectId ? remove.eq("project_id", grant.projectId) : remove.is("project_id", null);
  const { error: removeError } = await remove;
  if (removeError) throw removeError;
  if (!grant.level) return;
  const { error } = await supabase
    .from("access_grants")
    .insert({ org_id: orgId, role_id: grant.roleId, project_id: grant.projectId, level: grant.level });
  // A role or project of another org, or one deleted meanwhile.
  if (error?.code === "23503") throw new AccessChangeError("That role or project isn't this org's.");
  // Set by another admin at the same moment: theirs stands.
  if (error?.code === "23505") throw new AccessChangeError("Someone changed that at the same moment. Reload to see it.");
  if (error) throw error;
}

/** An org's projects (connected repositories), by name, for granting on. */
export async function listOrgProjects(orgId: string): Promise<Array<{ id: string; fullName: string }>> {
  const { data, error } = await createSupabaseAdminClient()
    .from("projects")
    .select("id, full_name")
    .eq("org_id", orgId)
    .is("hidden_at", null)
    .order("full_name");
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, fullName: p.full_name }));
}
