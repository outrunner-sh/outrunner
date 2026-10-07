import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { LocalWorkspaceView } from "@/components/local-workspace-view";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjects, listWorkspaces } from "@/lib/db/repositories";

export const dynamic = "force-dynamic";

/**
 * A local session: Claude Code running on this Mac. The server holds no record
 * of it — the page is a shell around the sidebar, and the session itself is
 * read from the Mac by the Outrunner app.
 */
export default async function LocalWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");
  const { id } = await params;
  const { prompt } = await searchParams;
  // The sidebar is auxiliary: a failed load must not take down the session.
  const [allWorkspaces, allProjects] = await Promise.all([
    listWorkspaces().catch((error) => {
      console.error("Could not load workspaces", error);
      return [];
    }),
    listProjects().catch((error) => {
      console.error("Could not load repositories", error);
      return [];
    }),
  ]);
  return (
    <AppShell immersive>
      <LocalWorkspaceView
        workspaceId={id}
        allProjects={allProjects}
        allWorkspaces={allWorkspaces}
        initialPrompt={prompt}
      />
    </AppShell>
  );
}
