import type { RuntimeComputer } from "@/lib/runtime/types";

/**
 * Where a cloud session's worktree can be read or committed: its box and
 * folder, or why not now. Checked before any git runs on the box: a paused box
 * answers no command, which would otherwise surface as a generic 500.
 */
export function reachableWorktree(
  computer: Pick<RuntimeComputer, "status" | "daytonaSandboxId"> | null,
  worktreePath: string | null,
): { ok: true; sandboxId: string; worktree: string } | { ok: false; error: string } {
  if (!computer?.daytonaSandboxId) return { ok: false, error: "The interactive worktree is not available yet." };
  if (computer.status === "stopped") {
    return { ok: false, error: "This session's box is paused. Open the session to wake it, then try again." };
  }
  if (computer.status !== "ready") {
    return { ok: false, error: "This session's box isn't ready yet. Open the session, then try again." };
  }
  if (!worktreePath) return { ok: false, error: "The interactive worktree is not available yet." };
  return { ok: true, sandboxId: computer.daytonaSandboxId, worktree: worktreePath };
}

/** Why a message's files can't be written to the box, or null when they can:
 *  with no worktree on record they would land in `/.attachments`, where Claude
 *  would not look. A message without files is never refused here. */
export function attachmentsUnavailable(attachmentCount: number, worktreePath: string | null): string | null {
  if (attachmentCount === 0 || worktreePath) return null;
  return "Files can't be attached to this session yet. Send the message without them.";
}
