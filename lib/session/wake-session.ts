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
  // A ready box does not prove its Claude process is alive. tmux drops a
  // session when Claude exits, while both workspace and computer rows stay
  // ready. Attach is idempotent and starts the session again from its saved
  // conversation when that happened, so do it before every send to a live
  // session rather than sending into a missing tmux session.
  if (workspaceStatus === "ready" || workspaceStatus === "idle") return ["attach"];
  const steps: ("attach" | "resume")[] = computerStatus === "ready" ? [] : ["attach"];
  // A suspended session on a paused box starts twice: the attach brings the
  // box back and starts its agent, then resume relaunches it. Expected, and
  // kept: resume is what marks it ready (it brings a paused box back too, for
  // the callers that resume without attaching).
  if (workspaceStatus === "suspended") steps.push("resume");
  return steps;
}
