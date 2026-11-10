/**
 * The codes the session routes hand the page alongside an error, so the page
 * can say something the plain message cannot (lib/session/session-codes.ts is
 * the one place they are named). Shared by producer and consumer on purpose:
 * renaming one side can't silently stop matching the other.
 */

/** The session's box is gone and can't be restored: retrying cannot help, so
 *  the page points at a new session instead of offering one.
 *  app/api/workspaces/[id]/session/route.ts, .../message/route.ts */
export const BOX_GONE = "box-gone";

/** Restoring the box failed, which is usually brief: retrying can help.
 *  app/api/workspaces/[id]/session/route.ts */
export const BOX_RESTORE_FAILED = "box-restore-failed";

/** The session's agent didn't start on its box (it exited at launch, or its
 *  relaunch failed), so nothing would answer it: the page says why, with
 *  Try again. app/api/workspaces/[id]/session/route.ts */
export const SESSION_NOT_STARTED = "session-not-started";

/** The session was archived or deleted since the page loaded (another tab,
 *  an automation, a Mission): it isn't attached again, and retrying can't
 *  help. app/api/workspaces/[id]/session/route.ts */
export const SESSION_ENDED = "session-ended";
