/**
 * How the API wakes a session before a message reaches it (POST
 * /workspaces/{id}/messages, and the Cursor-compatible follow-up through it),
 * as opening it in the app would:
 *
 *   resume    paused (suspended): the lifecycle route's resume
 *   restore   archived: the lifecycle route's restore
 *   open      ready, but its box isn't up: the session route, as the session
 *             page opens it, which brings the box back and starts the agent
 *             on it again
 *
 * The last is the common one. The reconciler pauses a box idle for 15 minutes
 * (lib/billing/reconcile.ts) and marks only its computer stopped, so the
 * session stays ready. Without it, a follow-up to a session that finished a
 * while ago was refused every time ("Runtime Computer is not ready.", 409).
 */

import type { RuntimeComputerStatus, WorkspaceStatus } from "@/lib/runtime/types";

export type Wake = "resume" | "restore" | "open";

/** How to wake a session in `session` status whose computer is in
 *  `computer` (null: it has none); null when there's nothing to wake. */
export function wakeFor(session: WorkspaceStatus, computer: RuntimeComputerStatus | null): Wake | null {
  if (session === "suspended") return "resume";
  if (session === "archived") return "restore";
  if ((session === "ready" || session === "idle") && computer !== null && computer !== "ready") return "open";
  return null;
}
