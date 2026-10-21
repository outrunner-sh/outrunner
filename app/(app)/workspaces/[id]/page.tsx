import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { RouteLoading } from "@/components/route-states";
import { ServerAnswer } from "@/components/server-answer";
import { SessionRoute } from "@/components/session-route";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getProjectOnce } from "@/lib/db/request-cache";
import type { SessionAnswer } from "@/lib/session/session-view";

/** A click on a session never waits on the server: the build checks it, on a
 *  sample session opened from the sidebar (no first prompt). */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      params: { id: "sample" },
      searchParams: { prompt: null, attachment: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
      ],
    },
  ],
};

type Params = Promise<{ id: string }>;

/**
 * A cloud session. It renders from the sidebar's data at once (SessionRoute);
 * the server's read streams in behind it, for a session the sidebar doesn't
 * have yet and to turn one that is gone into not-found. (The outer boundary is
 * for a page load, where the URL is read on the client.)
 */
export default function WorkspacePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<RouteLoading label="Opening session" />}>
      <SessionRoute
        server={
          <Suspense fallback={null}>
            <ServerSession params={params} />
          </Suspense>
        }
      />
    </Suspense>
  );
}

async function ServerSession({ params }: { params: Params }) {
  // Signed out is the proxy's to catch; this is a signed-in user who isn't the
  // allowlisted owner.
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  // A deleted session keeps its row, marked destroyed: say so, rather than
  // leaving the user to wonder whether the link was wrong.
  if (workspace.status === "destroyed") {
    return (
      <ServerAnswer<SessionAnswer>
        value={{ gone: { workspace, pullRequest: await getWorkspacePullRequest(workspace.id) } }}
      />
    );
  }
  const [project, pullRequest] = await Promise.all([
    getProjectOnce(workspace.projectId),
    getWorkspacePullRequest(workspace.id),
  ]);
  if (!project) notFound();

  return <ServerAnswer<SessionAnswer> value={{ workspace, projectName: project.fullName, pullRequest }} />;
}
