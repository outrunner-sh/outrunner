import type { WorkspaceStatus } from "@/lib/runtime/types";

/**
 * Why a session can't be attached to (POST /api/workspaces/[id]/session), or
 * null when it can. Attaching brings a paused box back and starts Claude on
 * it, so a tab still showing a session archived or deleted elsewhere (another
 * tab, an automation's next run, a Mission) would run it again, outside the
 * Snapshot that Restore rebuilds from, and bill its hours.
 */
export function sessionGoneMessage(status: WorkspaceStatus): string | null {
  switch (status) {
    case "archiving":
    case "archived":
      return "This session is archived. Restore it to continue.";
    case "destroying":
    case "destroyed":
      return "This session was deleted.";
    default:
      return null;
  }
}
