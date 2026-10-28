import { cookies } from "next/headers";
import { Suspense } from "react";

import { AppFrame, type FrameChrome, type FrameData } from "@/components/app-frame";
import { ServerAnswer } from "@/components/server-answer";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProjects, listWorkspacePullRequests } from "@/lib/db/repositories";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import { countTriage, triageActor } from "@/lib/db/work-items";
import { GET_STARTED_COOKIE } from "@/lib/nav/get-started";
import { FOLDED_PROJECTS_COOKIE, readFoldedProjects, SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import { getOrgContext } from "@/lib/orgs/server";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";

/**
 * Every app page (home, new session, a cloud or local session) under one
 * sidebar. A layout rather than a component on each page, so the sidebar is
 * rendered once and stays put (scroll, search, collapse) as you move between
 * sessions; router.refresh() re-reads its data after a change. The pages
 * render from the same data (components/app-data.tsx), so a click in the
 * sidebar shows its session without asking the server first.
 *
 * The frame itself reads nothing: it shows at once, even on a cold start, and
 * what the sidebar lists streams in under Suspense (SidebarData). Signed out
 * is the proxy's to catch; a signed-in user who isn't the owner gets an empty
 * sidebar while the page under it sends them to sign-in.
 *
 * How the sidebar was left (ChromeData) is a boundary of its own, ahead of the
 * list it holds: it reads cookies and nothing else, so a sidebar left
 * collapsed is collapsed from the first paint rather than opening wide and
 * snapping shut once the queries answer (lib/nav/sidebar.ts).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppFrame
      chrome={
        <Suspense fallback={null}>
          <ChromeData />
        </Suspense>
      }
      server={
        <Suspense fallback={null}>
          <SidebarData />
        </Suspense>
      }
    >
      {children}
    </AppFrame>
  );
}

/** The sidebar as the user left it: its cookies, read without asking Supabase
 *  or the database, so this lands before {@link SidebarData} does. */
async function ChromeData() {
  const jar = await cookies();
  return (
    <ServerAnswer<FrameChrome>
      value={{
        collapsed: jar.get(SIDEBAR_COOKIE)?.value === "1",
        folded: readFoldedProjects(jar.get(FOLDED_PROJECTS_COOKIE)?.value),
        getStartedSkipped: jar.get(GET_STARTED_COOKIE)?.value === "1",
      }}
    />
  );
}

async function SidebarData() {
  const owner = await getOwnerSafe();
  if (!owner) return null;

  // The active org's projects and the user's sessions in it (lib/orgs/active.ts).
  // The sidebar is auxiliary: a failed load shows an empty list, never an error
  // page in place of the session the user opened.
  const orgs = await getOrgContext().catch((error: unknown) => {
    console.error("Sidebar: could not load orgs", error);
    return null;
  });
  const orgId = orgs?.active.id;
  const [listed, workspaces] = await Promise.all([
    listProjectsOnce(orgId).catch((error: unknown): Project[] => {
      console.error("Sidebar: could not load repositories", error);
      return [];
    }),
    listWorkspacesOnce(orgId).catch((error: unknown): Workspace[] => {
      console.error("Sidebar: could not load workspaces", error);
      return [];
    }),
  ]);
  const [hidden, pullRequests, triageCount] = await Promise.all([
    hiddenSessionProjects(listed, workspaces),
    listWorkspacePullRequests(workspaces.map((w) => w.id)).catch((error: unknown): WorkspacePullRequest[] => {
      console.error("Sidebar: could not load pull requests", error);
      return [];
    }),
    // What waits in the active org's triage that the user may see.
    (orgId ? triageActor(owner.id, orgId).then((actor) => (actor ? countTriage(actor) : 0)) : Promise.resolve(0)).catch((error: unknown): number => {
      console.error("Sidebar: could not count triage", error);
      return 0;
    }),
  ]);

  return (
    <ServerAnswer<FrameData>
      value={{
        appData: {
          projects: listed,
          hiddenProjects: hidden,
          workspaces,
          pullRequests: sessionPullRequests(workspaces, pullRequests),
        },
        ownerLogin: owner.githubLogin,
        ownerAvatarUrl: owner.avatarUrl,
        orgs: orgs?.orgs ?? [],
        activeOrgId: orgId ?? null,
        triageCount,
      }}
    />
  );
}

/**
 * The projects a session belongs to that the list hides (a hidden repository),
 * so that session's group is named rather than shown under a placeholder.
 * Usually none; one query when there are.
 */
async function hiddenSessionProjects(listed: Project[], workspaces: Workspace[]): Promise<Project[]> {
  const known = new Set(listed.map((p) => p.id));
  const missing = [...new Set(workspaces.map((w) => w.projectId))].filter((id) => !known.has(id));
  return getProjects(missing).catch((error: unknown): Project[] => {
    console.error("Sidebar: could not load hidden repositories", error);
    return [];
  });
}

/** One pull request a session for the sidebar: its own repository's, else
 *  (a session of several that opened one elsewhere first) its oldest. The
 *  session's page reads each repository's itself. */
function sessionPullRequests(
  workspaces: Workspace[],
  pullRequests: WorkspacePullRequest[],
): Record<string, WorkspacePullRequest> {
  const own = new Map(workspaces.map((w) => [w.id, w.projectId]));
  const picked: Record<string, WorkspacePullRequest> = {};
  for (const pr of pullRequests) {
    const current = picked[pr.workspaceId];
    if (!current || (current.projectId !== own.get(pr.workspaceId) && pr.projectId === own.get(pr.workspaceId))) {
      picked[pr.workspaceId] = pr;
    }
  }
  return picked;
}
