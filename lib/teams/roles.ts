/**
 * Who may do what in a workspace (a team, in the database). The database
 * enforces all of it (supabase/migrations/20261009140000_team_access.sql);
 * this mirrors it so the UI offers only what will be allowed, and routes can
 * refuse with a clear message before calling anything. No imports, so it
 * unit-tests without Next or a database.
 */

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export type Team = { id: string; name: string; personal: boolean; role: TeamRole };

export const ROLE_LABEL: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTION: Record<TeamRole, string> = {
  owner: "Everything, including roles and deleting the workspace",
  admin: "Invites and removes people, adds projects",
  member: "Runs sessions on the workspace's projects",
  viewer: "Watches sessions, can't start or type in one",
};

/** Owners and admins manage the workspace: its name, projects and invites. */
export function managesTeam(role: TeamRole | null): boolean {
  return role === "owner" || role === "admin";
}

/** Everyone but viewers starts sessions. */
export function runsSessions(role: TeamRole | null): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** The roles `role` may invite with: never owner (made one once joined), and
 *  admins only by owners. */
export function invitableRoles(role: TeamRole | null): TeamRole[] {
  if (role === "owner") return ["admin", "member", "viewer"];
  if (role === "admin") return ["member", "viewer"];
  return [];
}

/** Whether someone with `actor` may remove a member with `target`; anyone may
 *  leave. (The database also keeps a last owner.) */
export function canRemove(actor: TeamRole | null, target: TeamRole, self: boolean): boolean {
  if (self) return true;
  if (actor === "owner") return true;
  return actor === "admin" && (target === "member" || target === "viewer");
}

/**
 * What someone may do in a session: its creator acts in it (prompts, model,
 * commits); the workspace's owners and admins may also stop, archive or remove
 * it; everyone else in the workspace watches.
 */
export type SessionAccess = "act" | "manage" | "watch";

export function sessionAccess(userId: string, sessionOwnerId: string, role: TeamRole | null): SessionAccess {
  if (userId === sessionOwnerId) return "act";
  return managesTeam(role) ? "manage" : "watch";
}

/** The workspace to show: the one picked last, if still the user's, else
 *  their personal one. Null only for a user in no team at all. */
export function pickTeam(teams: Team[], picked: string | undefined): Team | null {
  return teams.find((t) => t.id === picked) ?? teams.find((t) => t.personal) ?? teams[0] ?? null;
}

/** Personal first, then by name. */
export function sortTeams(teams: Team[]): Team[] {
  return [...teams].sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
}
