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
import { GROUPING_COOKIE, readGrouping } from "@/lib/nav/status-groups";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/active";
import { getOrgContext } from "@/lib/orgs/server";
import { readStandingRows, standingsFrom } from "@/lib/db/session-standing";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { sessionPullRequests } from "@/lib/session/session-view";

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
        grouping: readGrouping(jar.get(GROUPING_COOKIE)?.value),
        // Which org's list the browser kept may stand in for
        // (components/app-frame.tsx): null before the switcher was ever used.
        pickedOrgId: jar.get(ACTIVE_ORG_COOKIE)?.value ?? null,
      }}
    />
  );
}

async function SidebarData() {
  // Who is signed in and which orgs are theirs, read together: the org query
  // runs under the same session cookie, and RLS answers it as that user.
  // The sidebar is auxiliary: a failed load shows an empty list, never an
  // error page in place of the session the user opened.
  const orgsRead = getOrgContext().then(
    (context) => ({ context }),
    (error: unknown) => ({ error }),
  );
  const owner = await getOwnerSafe();
  // Nobody signed in (a prerender among them): the orgs' answer is no one's.
  if (!owner) return null;
  const read = await orgsRead;
  if ("error" in read) console.error("Sidebar: could not load orgs", read.error);
  const orgs = "context" in read ? read.context : null;

  // The active org's projects and the user's sessions in it
  // (lib/orgs/active.ts), and what waits in its triage that the user may see
  // — a member of their own org, as getOrgContext read it.
  const orgId = orgs?.active.id;
  const triageCount = (orgId ? triageActor(owner.id, orgId, true).then((actor) => (actor ? countTriage(actor) : 0)) : Promise.resolve(0)).catch(
    (error: unknown): number => {
      console.error("Sidebar: could not count triage", error);
      return 0;
    },
  );
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
  // Everything that needs only the sessions' ids, at once: their pull
  // requests, the repositories they're in that the list hides, and what
  // places each in its group. Placed by the page's own poll
  // (hooks/use-standings.ts) if that can't be read now.
  const [hidden, pullRequests, standingRows] = await Promise.all([
    hiddenSessionProjects(listed, workspaces),
    listWorkspacePullRequests(workspaces.map((w) => w.id)).catch((error: unknown): WorkspacePullRequest[] => {
      console.error("Sidebar: could not load pull requests", error);
      return [];
    }),
    readStandingRows(owner.id, workspaces.map((w) => w.id)).catch((error: unknown) => {
      console.error("Sidebar: could not read where sessions stand", error);
      return undefined;
    }),
  ]);

  const picked = sessionPullRequests(workspaces, pullRequests);
  const standings = standingRows ? standingsFrom(owner.id, workspaces, picked, standingRows) : undefined;

  return (
    <ServerAnswer<FrameData>
      value={{
        appData: {
          projects: listed,
          hiddenProjects: hidden,
          workspaces,
          pullRequests: picked,
          standings,
        },
        ownerLogin: owner.githubLogin || owner.name,
        ownerAvatarUrl: owner.avatarUrl,
        orgs: orgs?.orgs ?? [],
        activeOrgId: orgId ?? null,
        triageCount: await triageCount,
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
