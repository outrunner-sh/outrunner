import { redirect } from "next/navigation";

import { HomeView } from "@/components/home-view";
import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import { workspaceLabel } from "@/lib/nav/session-title";
import { newestFirst, recency } from "@/lib/nav/workspace-nav-groups";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  // Shared with the sidebar's read in app/(app)/layout.tsx: one query each.
  const workspaces = await listWorkspacesOnce();

  // Repositories feed the new-session picker. A failed load must not block the
  // create flow.
  let projects: Project[] = [];
  try {
    projects = await listProjectsOnce();
  } catch (error) {
    console.error("Could not load repositories", error);
  }

  // No workspaces yet: open straight into the new-session screen.
  if (workspaces.length === 0) {
    return (
      <NewSessionCreator projects={projects} />
    );
  }

  const projectsById = new Map(projects.map((project) => [project.id, project]));

  // The single session to "Continue" in the center column. listWorkspaces sorts
  // by last_active_at with nulls last, so a brand-new (still-provisioning)
  // workspace — whose last_active_at is null — sorts to the tail; rank by
  // `lastActiveAt ?? createdAt` (the sidebar's rule) so the newest wins.
  const recent = workspaces.reduce((a, b) =>
    newestFirst(recency(a), recency(b)) > 0 ? b : a,
  );
  const lastSession = recent
    ? {
        id: recent.id,
        title: workspaceLabel(recent),
        project: projectsById.get(recent.projectId)?.name ?? "repository",
      }
    : null;

  return (
    <HomeView
      ownerLogin={owner.githubLogin}
      projects={projects}
      lastSession={lastSession}
      lastProjectId={recent?.projectId}
    />
  );
}
