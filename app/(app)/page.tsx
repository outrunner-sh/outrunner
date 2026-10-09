import { redirect } from "next/navigation";

import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import { getOnboardingUser } from "@/lib/onboarding/server";
import type { Project, Workspace } from "@/lib/runtime/types";
import { lastSessionProjectId } from "@/lib/session/initial-project";

export const dynamic = "force-dynamic";

/**
 * Home is the new-session screen: every session is in the sidebar, so the page
 * itself is for starting the next one. A new user is sent through onboarding
 * first.
 */
export default async function Home() {
  // The control plane is owner-only; unauthenticated visitors go to sign-in.
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  // Both shared with the sidebar's reads in app/(app)/layout.tsx: one query
  // each. Neither failing may block starting a session.
  const [projects, { workspaces, loaded }] = await Promise.all([
    listProjectsOnce().catch((error: unknown): Project[] => {
      console.error("Could not load repositories", error);
      return [];
    }),
    listWorkspacesOnce().then(
      (workspaces) => ({ workspaces, loaded: true }),
      (error: unknown) => {
        console.error("Could not load workspaces", error);
        return { workspaces: [] as Workspace[], loaded: false };
      },
    ),
  ]);

  // A new user starts with onboarding; anyone with a session is past it,
  // marked or not. Only a list that really loaded empty counts: a failed read
  // must not send an existing user there.
  if (loaded && workspaces.length === 0) {
    const user = await getOnboardingUser().catch(() => null);
    if (user && !user.onboardedAt) redirect("/onboarding");
  }

  return <NewSessionCreator projects={projects} initialProjectId={lastSessionProjectId(projects, workspaces)} />;
}
