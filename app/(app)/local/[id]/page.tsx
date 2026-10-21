import { Suspense } from "react";

import { LocalWorkspaceView } from "@/components/local-workspace-view";
import { RequireOwner } from "@/components/require-owner";

export const dynamic = "force-dynamic";

/**
 * A local session: Claude Code running on this Mac. The server holds no record
 * of it: the session itself is read from the Mac by the Outrunner app.
 */
export default function LocalWorkspacePage() {
  return (
    <>
      <LocalWorkspaceView />
      <Suspense fallback={null}>
        <RequireOwner />
      </Suspense>
    </>
  );
}
