import { randomBytes } from "node:crypto";

import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { githubLogin } from "@/lib/auth/allowlist";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { asSentence, pickTeam, sortTeams, type Team, type TeamRole } from "@/lib/teams/roles";

/**
 * Workspaces people share (teams, in the database). Reads go through RLS, so
 * a user sees only their own teams, their members and, as an owner or admin,
 * their invites. Every change goes through a database function that checks
 * the caller's role itself (20261009140000_team_access.sql).
 */

/** The workspace picked last, kept across visits. */
export const CURRENT_TEAM_COOKIE = "outrunner-workspace";

export type TeamMember = {
  userId: string;
  role: TeamRole;
  githubLogin: string | null;
  avatarUrl: string | null;
  joinedAt: string;
};

export type TeamInvite = {
  id: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

/** A change the database refused, with the status to answer and its message,
 *  which is written for the user. */
export class TeamActionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TeamActionError";
    this.status = status;
  }
}

/** The database's refusal, by its SQLSTATE: the role doesn't allow it (42501),
 *  a rule it would break (23514), or nothing to act on (P0002). */
function refused(error: { code?: string; message: string }): never {
  const status = error.code === "42501" ? 403 : error.code === "23514" ? 409 : error.code === "P0002" ? 404 : 0;
  if (status) throw new TeamActionError(status, asSentence(error.message));
  throw error;
}

/** The teams the user is in, personal first. */
export async function listMyTeams(userId: string): Promise<Team[]> {
  const supabase = await createSupabaseServerClient();
  const { data: memberships, error } = await supabase
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", userId);
  if (error) throw error;
  if (!memberships?.length) return [];

  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, name, personal")
    .in("id", memberships.map((m) => m.team_id));
  if (teamsError) throw teamsError;

  const roles = new Map(memberships.map((m) => [m.team_id, m.role]));
  return sortTeams(
    (teams ?? []).map((t) => ({ id: t.id, name: t.name, personal: t.personal, role: roles.get(t.id) ?? "viewer" })),
  );
}

/** The workspace the app shows: the one picked last if still the user's,
 *  otherwise their personal one. */
export async function currentTeam(userId: string): Promise<Team | null> {
  const picked = (await cookies()).get(CURRENT_TEAM_COOKIE)?.value;
  return pickTeam(await listMyTeams(userId), picked);
}

/** The user's role in a team, or null when they aren't in it. */
export async function teamRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.role ?? null;
}

/** The user's personal team: where their own GitHub repositories go. */
export async function personalTeamId(userId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("teams")
    .select("id")
    .eq("personal", true)
    .eq("created_by", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No personal workspace for ${userId}.`);
  return data.id;
}

/** A team's members with how they show: owners first, then by login. */
export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  const supabase = await createSupabaseServerClient();
  const { data: members, error } = await supabase
    .from("team_members")
    .select("user_id, role, created_at")
    .eq("team_id", teamId);
  if (error) throw error;
  if (!members?.length) return [];

  const { data: profiles, error: profilesError } = await supabase
    .from("user_profiles")
    .select("user_id, github_login, avatar_url")
    .in("user_id", members.map((m) => m.user_id));
  if (profilesError) throw profilesError;

  const byUser = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  const order: Record<TeamRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };
  return members
    .map((m) => ({
      userId: m.user_id,
      role: m.role,
      githubLogin: byUser.get(m.user_id)?.github_login ?? null,
      avatarUrl: byUser.get(m.user_id)?.avatar_url ?? null,
      joinedAt: m.created_at,
    }))
    .sort((a, b) => order[a.role] - order[b.role] || (a.githubLogin ?? "").localeCompare(b.githubLogin ?? ""));
}

/** A team's invites, newest first. Owners and admins see them; others get none. */
export async function listTeamInvites(teamId: string): Promise<TeamInvite[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("team_invites")
    .select("id, role, created_at, expires_at, accepted_at, revoked_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((i) => ({
    id: i.id,
    role: i.role,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    acceptedAt: i.accepted_at,
    revokedAt: i.revoked_at,
  }));
}

/** Create a team the caller owns. */
export async function createTeam(name: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_team", { team_name: name });
  if (error) refused(error);
  return data as string;
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("rename_team", { team: teamId, team_name: name });
  if (error) refused(error);
}

/** Make an invite link's token. Only its hash is stored, so the link can be
 *  shown once, now. */
export async function createTeamInvite(teamId: string, role: TeamRole): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_team_invite", { team: teamId, invite_role: role, token });
  if (error) refused(error);
  return { id: data as string, token };
}

export async function revokeTeamInvite(inviteId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("revoke_team_invite", { invite: inviteId });
  if (error) refused(error);
}

/** What an invite would join, or null for one that can't be used. */
export async function previewTeamInvite(token: string): Promise<{ teamName: string; role: TeamRole } | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("team_invite_preview", { token });
  if (error) throw error;
  const row = data?.[0];
  return row ? { teamName: row.team_name, role: row.invite_role } : null;
}

/** Join the invite's team; returns its id. */
export async function acceptTeamInvite(token: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("accept_team_invite", { token });
  if (error) refused(error);
  return data as string;
}

export async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_team_member_role", { team: teamId, member: userId, new_role: role });
  if (error) refused(error);
}

/** Remove a member, or leave (userId = the caller). */
export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("remove_team_member", { team: teamId, member: userId });
  if (error) refused(error);
}

/** Delete the team row and everything under it. The caller destroys the
 *  team's computers first: the rows cascade, the boxes would not. */
export async function deleteTeamRow(teamId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("delete_team", { team: teamId });
  if (error) refused(error);
}

/**
 * Every Runtime Computer on a team's projects, whoever owns it. Service role:
 * a computer row holds its agent's secret, so no one reads another member's;
 * this is for an owner deleting the team, after checking they are one.
 */
export async function teamComputersForDeletion(
  teamId: string,
): Promise<Array<{ id: string; sandboxId: string | null }>> {
  const admin = createSupabaseAdminClient();
  const { data: projects, error } = await admin.from("projects").select("id").eq("team_id", teamId);
  if (error) throw error;
  if (!projects?.length) return [];
  const { data, error: computersError } = await admin
    .from("runtime_computers")
    .select("id, daytona_sandbox_id")
    .in("project_id", projects.map((p) => p.id));
  if (computersError) throw computersError;
  return (data ?? []).map((c) => ({ id: c.id, sandboxId: c.daytona_sandbox_id }));
}

/** Record how the user shows to teammates: their GitHub login and avatar.
 *  Called at each sign-in; best effort. */
export async function saveUserProfile(user: User): Promise<void> {
  const meta = user.user_metadata as Record<string, unknown> | null;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_profiles").upsert({
    user_id: user.id,
    github_login: githubLogin(user),
    avatar_url: typeof meta?.avatar_url === "string" ? meta.avatar_url : null,
  });
  if (error) throw error;
}

/** How a teammate shows (null for someone you share no workspace with). */
export async function getUserProfile(
  userId: string,
): Promise<{ githubLogin: string | null; avatarUrl: string | null } | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("github_login, avatar_url")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? { githubLogin: data.github_login, avatarUrl: data.avatar_url } : null;
}
