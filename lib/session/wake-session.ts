import type { RuntimeComputerStatus, WorkspaceStatus } from "@/lib/runtime/types";

/**
 * What waking a session takes before a prompt can reach it, in order: its box
 * brought back and its agent started ("attach", as opening the session does),
 * when the box isn't up; then resumed, if it was suspended, or restored, if
 * archived (which brings up a box of its own). A session left ready while
 * its box was paused, idle (lib/billing/reconcile.ts), needs the attach: the
 * message route sends only to a box that's up, so Slack replies, send-backs
 * and research follow-ups to any session idle for 15 minutes were refused.
 */
export function wakeSteps(
  workspaceStatus: WorkspaceStatus,
  computerStatus: RuntimeComputerStatus | null,
): ("attach" | "resume" | "restore")[] {
  if (workspaceStatus === "archived") return ["restore"];
  const steps: ("attach" | "resume")[] = computerStatus === "ready" ? [] : ["attach"];
  // A suspended session on a paused box starts twice: the attach brings the
  // box back and starts its agent, then resume relaunches it. Expected, and
  // kept: resume is what marks it ready, and only an attach brings the box
  // back for it to run on.
  if (workspaceStatus === "suspended") steps.push("resume");
  return steps;
}
