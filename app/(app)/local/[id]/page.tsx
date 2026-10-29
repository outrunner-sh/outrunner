import { Suspense } from "react";

import { LocalWorkspaceView } from "@/components/local-workspace-view";
import { RequireOwner } from "@/components/require-owner";
import { SessionLoading } from "@/components/route-states";

/** A click on a session never waits on the server: the build checks it, on a
 *  sample session opened from the sidebar (no first prompt). */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      params: { id: "sample" },
      searchParams: { prompt: null, chat: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
  ],
};

/**
 * A local session: Claude Code running on this Mac. The server holds no record
 * of it: the session itself is read from the Mac by the Outrunner app. (The
 * boundary is for a page load, where the URL is read on the client.)
 */
export default function LocalWorkspacePage() {
  return (
    <>
      <Suspense fallback={<SessionLoading />}>
        <LocalWorkspaceView />
      </Suspense>
      <Suspense fallback={null}>
        <RequireOwner />
      </Suspense>
    </>
  );
}
