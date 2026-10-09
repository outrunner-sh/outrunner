import { redirect } from "next/navigation";

import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import type { Project, Workspace } from "@/lib/runtime/types";
import { lastSessionProjectId } from "@/lib/session/initial-project";

export const dynamic = "force-dynamic";

/**
 * Home is the new-session screen: every session is in the sidebar, so the page
 * itself is for starting the next one.
 */
export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  // Both shared with the sidebar's reads in app/(app)/layout.tsx: one query
  // each. Neither failing may block starting a session.
  const [projects, workspaces] = await Promise.all([
    listProjectsOnce().catch((error: unknown): Project[] => {
      console.error("Could not load repositories", error);
      return [];
    }),
    listWorkspacesOnce().catch((error: unknown): Workspace[] => {
      console.error("Could not load workspaces", error);
      return [];
    }),
  ]);

  return <NewSessionCreator projects={projects} initialProjectId={lastSessionProjectId(projects, workspaces)} />;
}
