import { cookies } from "next/headers";

import { AppFrame } from "@/components/app-frame";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProjects } from "@/lib/db/repositories";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import { FOLDED_PROJECTS_COOKIE, readFoldedProjects, SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Project, Workspace } from "@/lib/runtime/types";

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
  const [listed, workspaces] = await Promise.all([
    listProjectsOnce().catch((error: unknown): Project[] => {
      console.error("Sidebar: could not load repositories", error);
      return [];
    }),
    listWorkspacesOnce().catch((error: unknown): Workspace[] => {
      console.error("Sidebar: could not load workspaces", error);
      return [];
    }),
  ]);
  const projects = await withSessionProjects(listed, workspaces);
  const jar = await cookies();
  const collapsed = jar.get(SIDEBAR_COOKIE)?.value === "1";
  const folded = readFoldedProjects(jar.get(FOLDED_PROJECTS_COOKIE)?.value);

  return (
    <AppFrame
      projects={projects}
      workspaces={workspaces}
      ownerLogin={owner.githubLogin}
      ownerAvatarUrl={owner.avatarUrl}
      initialCollapsed={collapsed}
      initialFolded={folded}
    >
      {children}
    </AppFrame>
  );
}

/**
 * The listed projects, plus any a session belongs to that the list hides (a
 * hidden repository), so that session's group is named rather than shown under
 * a placeholder. Usually adds nothing; one query when it does.
 */
async function withSessionProjects(listed: Project[], workspaces: Workspace[]): Promise<NavProject[]> {
  const known = new Set(listed.map((p) => p.id));
  const missing = [...new Set(workspaces.map((w) => w.projectId))].filter((id) => !known.has(id));
  const found = await getProjects(missing).catch((error: unknown): Project[] => {
    console.error("Sidebar: could not load hidden repositories", error);
    return [];
  });
  return [...listed, ...found];
}
