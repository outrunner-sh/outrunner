import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { ServerSessionView, SessionRoute } from "@/components/session-route";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getProjectOnce } from "@/lib/db/request-cache";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/**
 * A cloud session. It renders from the sidebar's data at once (SessionRoute);
 * the server's read streams in behind it, for a session the sidebar doesn't
 * have yet and to turn one that is gone into not-found.
 */
export default function WorkspacePage({ params }: { params: Params }) {
  return (
    <SessionRoute
      server={
        <Suspense fallback={null}>
          <ServerSession params={params} />
        </Suspense>
      }
    />
  );
}

async function ServerSession({ params }: { params: Params }) {
  // Signed out is the proxy's to catch; this is a signed-in user who isn't the
  // allowlisted owner.
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const workspace = await getWorkspace(id);
  // A deleted session keeps its row, marked destroyed: it is gone all the same.
  if (!workspace || workspace.status === "destroyed") notFound();
  const [project, pullRequest] = await Promise.all([
    getProjectOnce(workspace.projectId),
    getWorkspacePullRequest(workspace.id),
  ]);
  if (!project) notFound();

  return <ServerSessionView view={{ workspace, projectName: project.fullName, pullRequest }} />;
}
