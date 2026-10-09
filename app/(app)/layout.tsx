import { AppFrame } from "@/components/app-frame";
import { getOwnerSafe } from "@/lib/auth/owner";
import {
  currentTeamOnce,
  getProjectOnce,
  listProjectsOnce,
  listTeamMembersOnce,
  listWorkspacesOnce,
} from "@/lib/db/request-cache";
import { listMyTeams, type TeamMember } from "@/lib/db/teams";
import type { SidebarPerson } from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Project, Workspace } from "@/lib/runtime/types";
import type { Team } from "@/lib/teams/roles";

export const dynamic = "force-dynamic";

/**
 * Every app page (home, new session, a cloud or local session) under one
 * sidebar. A layout rather than a component on each page, so the sidebar is
 * rendered once and stays put (scroll, search, collapse) as you move between
 * sessions; router.refresh() re-reads its data after a change.
 *
 * Signed out, it renders the page alone: each page redirects to sign-in with
 * its own `next`, which a layout redirect would lose.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const owner = await getOwnerSafe();
  if (!owner) return children;

  // The sidebar is auxiliary: a failed load shows an empty list, never an error
  // page in place of the session the user opened.
  const [listed, workspaces, team, teams, members] = await Promise.all([
    listProjectsOnce().catch((error: unknown): Project[] => {
      console.error("Sidebar: could not load repositories", error);
      return [];
    }),
    listWorkspacesOnce().catch((error: unknown): Workspace[] => {
      console.error("Sidebar: could not load workspaces", error);
      return [];
    }),
    currentTeamOnce().catch((error: unknown): Team | null => {
      console.error("Sidebar: could not load the workspace", error);
      return null;
    }),
    listMyTeams(owner.id).catch((error: unknown): Team[] => {
      console.error("Sidebar: could not load workspaces to switch to", error);
      return [];
    }),
    listTeamMembersOnce().catch((error: unknown): TeamMember[] => {
      console.error("Sidebar: could not load the workspace's members", error);
      return [];
    }),
  ]);
  const projects = await withSessionProjects(listed, workspaces);
  const people: Record<string, SidebarPerson> = Object.fromEntries(
    members.map((m) => [m.userId, { login: m.githubLogin, avatarUrl: m.avatarUrl }]),
  );

  return (
    <AppFrame
      projects={projects}
      workspaces={workspaces}
      ownerId={owner.id}
      ownerLogin={owner.githubLogin}
      ownerAvatarUrl={owner.avatarUrl}
      team={team}
      teams={teams}
      people={people}
    >
      {children}
    </AppFrame>
  );
}

/**
 * The listed projects, plus any a session belongs to that the list hides (a
 * hidden repository), so that session's group is named rather than shown under
 * a placeholder. Usually adds nothing.
 */
async function withSessionProjects(listed: Project[], workspaces: Workspace[]): Promise<NavProject[]> {
  const known = new Set(listed.map((p) => p.id));
  const missing = [...new Set(workspaces.map((w) => w.projectId))].filter((id) => !known.has(id));
  const found = await Promise.all(missing.map((id) => getProjectOnce(id).catch(() => null)));
  return [...listed, ...found.filter((p): p is Project => p !== null)];
}
