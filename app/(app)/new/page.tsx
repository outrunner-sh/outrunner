import { Suspense } from "react";

import { NewSessionRoute } from "@/components/new-session-route";
import { RequireOwner } from "@/components/require-owner";
import { RouteLoading } from "@/components/route-states";
import { ServerAnswer } from "@/components/server-answer";
import { getProjectOnce } from "@/lib/db/request-cache";
import type { Project } from "@/lib/runtime/types";

/** "New Session" never waits on the server: the build checks it, on the bare
 *  form and on a project's "+". */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      searchParams: { project: null, folder: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
      ],
    },
    {
      searchParams: { project: "sample", folder: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
      ],
    },
  ],
};

type SearchParams = Promise<{ project?: string }>;

/** The new-session form a sidebar "+" opens. (The outer boundary is for a page
 *  load, where the URL is read on the client.) */
export default function NewSessionPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <Suspense fallback={<RouteLoading label="Loading" />}>
        <NewSessionRoute
          server={
            <Suspense fallback={null}>
              <RequestedProject searchParams={searchParams} />
            </Suspense>
          }
        />
      </Suspense>
      <Suspense fallback={null}>
        <RequireOwner />
      </Suspense>
    </>
  );
}

/** The repository `?project=` asks for, hidden or not, for the form to start
 *  on when the sidebar doesn't have it. */
async function RequestedProject({ searchParams }: { searchParams: SearchParams }) {
  const { project } = await searchParams;
  if (!project) return null;
  const requested = await getProjectOnce(project).catch(() => null);
  return requested ? <ServerAnswer<Project> value={requested} /> : null;
}
