import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { WorkspaceReplay } from "@/components/workspace-replay";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, getWorkspace, listWorkspaceSnapshots } from "@/lib/db/repositories";

/**
 * Replay view for a workspace's Snapshots — browser + storage only, no Runtime
 * Computer (M4 invariant #2). For an archived workspace: Settings → Archived
 * sessions' View, which it leads back to while the session stays archived.
 */
export default async function WorkspaceReplayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const workspace = await getWorkspace(id);
  // A deleted session keeps its row, marked destroyed: it is gone all the same.
  if (!workspace || workspace.status === "destroyed") notFound();
  const project = await getProject(workspace.projectId);
  if (!project) notFound();

  const snapshots = await listWorkspaceSnapshots(workspace.id);

  // Definite height (the app frame's content area) so the terminal/conversation
  // panels' h-full / flex-1 chain resolves instead of collapsing to content height.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
        {/* The session's own page would restore it: an archived one leads back
            to the list it was viewed from. */}
        <Link
          className="text-muted-foreground hover:underline"
          href={workspace.status === "archived" ? "/settings/archived" : `/workspaces/${workspace.id}`}
        >
          ← {project.fullName}
        </Link>
        <span className="font-medium">Replay · {workspace.branch}</span>
      </div>
      <div className="min-h-0 flex-1">
        <WorkspaceReplay workspaceId={workspace.id} snapshots={snapshots} />
      </div>
    </div>
  );
}
