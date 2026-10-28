import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";

/** The statuses a cloud session holds while its box is being set up. */
export const SETTING_UP: WorkspaceStatus[] = ["creating", "provisioning"];

/**
 * Past this, a session still setting up never will: its create ran in the
 * background of a server that has since stopped (a deploy, a crash). Well over
 * the longest real setup — a Runtime Computer waits up to 3 minutes on another
 * request's provisioning (lib/runtime/ensure-runtime-computer.ts) before its
 * own clone and start.
 */
export const SETUP_STALLS_AFTER_MS = 10 * 60_000;

/**
 * Past this since its row last changed, a session still setting up was cut
 * off (its setup ran in after() on a server a deploy has since replaced), and
 * the reconciler's cron fails it (lib/session/provisioning.deps.ts). From the
 * row's last change, not its start: each step writes its phase, so only the
 * longest single step need fit. That is the box's own making, in "allocate":
 * up to 3 minutes waiting on another request's provisioning, then Daytona's
 * 3-minute create or Neev's 10-minute prepare, then the clone of a large
 * repository. Well past SETUP_STALLS_AFTER_MS, so the page offers to keep
 * waiting first, and a slow setup that is still going is left alone. The
 * sweep sees only a row that stopped changing, so a step that hung (a call
 * with no deadline) is failed alike, hence the message's "may". One step has
 * no bound of its own: a Modal box's dependency install, which a large
 * monorepo on a cold volume could take past this, and be failed while going.
 */
export const SETUP_INTERRUPTED_AFTER_MS = 20 * 60_000;

/** What the session page says of a setup cut off. */
export const SETUP_INTERRUPTED_MESSAGE =
  "Setup stopped before it finished (Outrunner may have restarted while it ran). Try again to start a fresh session.";

/**
 * The sessions whose setup was cut off at `now`, and what they become:
 * setting up, their row unchanged since SETUP_INTERRUPTED_AFTER_MS ago,
 * failed with SETUP_INTERRUPTED_MESSAGE. One whose setup writes again in the
 * meantime no longer matches, so a setup still going is never failed.
 */
export function interruptedSetups(now: Date): {
  from: WorkspaceStatus[];
  unchangedSince: string;
  patch: { status: "failed"; errorMessage: string };
} {
  return {
    from: SETTING_UP,
    unchangedSince: new Date(now.getTime() - SETUP_INTERRUPTED_AFTER_MS).toISOString(),
    patch: { status: "failed", errorMessage: SETUP_INTERRUPTED_MESSAGE },
  };
}

/** Whether `status` is a session's box still being set up. */
export function isSettingUp(status: WorkspaceStatus): boolean {
  return SETTING_UP.includes(status);
}

/**
 * Where a session's setup stands at `now`: still running, ended (ready or
 * failed, or any later status), or stalled — set up for so long it never
 * finished, so it is shown as failed and may be deleted.
 */
export function setupState(
  workspace: Pick<Workspace, "status" | "createdAt">,
  now: number,
): "running" | "stalled" | "ended" {
  if (!isSettingUp(workspace.status)) return "ended";
  const created = Date.parse(workspace.createdAt);
  // A date that can't be read must not keep a session spinning for good.
  if (Number.isNaN(created)) return "stalled";
  return now - created >= SETUP_STALLS_AFTER_MS ? "stalled" : "running";
}

/** Statuses a cloud session can be deleted from, its setup over. */
const DESTROYABLE: WorkspaceStatus[] = ["ready", "idle", "suspended", "archived", "failed"];

/**
 * Whether a cloud session can be deleted at `now`: one whose setup ended and
 * no other change is under way, or whose setup stalled, which nothing else
 * will ever end. Both the lifecycle route and the sidebar ask this.
 */
export function canDestroy(workspace: Pick<Workspace, "status" | "createdAt">, now: number): boolean {
  return DESTROYABLE.includes(workspace.status) || setupState(workspace, now) === "stalled";
}

/**
 * Past this since its row last changed, a session still archiving, restoring,
 * resuming, suspending or being deleted was cut off: each runs in one request
 * (app/api/workspaces/[id]/lifecycle), and only that request's own catch ever
 * moved it on. A deploy or a crash mid-step left it there for good, a status
 * no other action starts from, and not one it can be deleted from. Well past
 * the longest of them, an archive's or a restore's transfer of a large
 * repository's Snapshot.
 */
export const TRANSITION_INTERRUPTED_AFTER_MS = 30 * 60_000;

const cutOff = (what: string, next: string) =>
  `${what} stopped before it finished (Outrunner may have restarted while it ran). ${next}`;

/**
 * Each status a lifecycle step holds, what a step cut off goes back to, and
 * what its page says. Back where the step started, so it can be tried again;
 * a delete cut off becomes failed, which can be deleted. An archive whose
 * Snapshot was kept before it was cut off is archived instead
 * (provisioning.deps.ts), as the step itself would have ended.
 */
export const INTERRUPTED_TRANSITIONS: { from: WorkspaceStatus; to: WorkspaceStatus; message: string }[] = [
  { from: "archiving", to: "ready", message: cutOff("Archiving", "Archive it again when you're ready.") },
  { from: "restoring", to: "archived", message: cutOff("Restoring", "Restore it again to pick up where it left off.") },
  { from: "resuming", to: "suspended", message: cutOff("Resuming", "Resume it again.") },
  { from: "suspending", to: "ready", message: cutOff("Suspending", "Suspend it again if you meant to.") },
  { from: "destroying", to: "failed", message: cutOff("Deleting", "Delete it again.") },
];

/** The time before which a lifecycle step's row, unchanged since, was cut off. */
export function transitionsInterruptedBefore(now: Date): string {
  return new Date(now.getTime() - TRANSITION_INTERRUPTED_AFTER_MS).toISOString();
}

/**
 * Past this since its row last changed, a box claimed for provisioning was
 * cut off: the claim (claim_workspace_computer, claim_runtime_computer) takes
 * over only a box in error or stopped, and its holder, the request that
 * provisions it, is the only one that moves it on. One a deploy cut off
 * mid-provision (a paused box being brought back, say) kept every later open
 * of its session waiting on it, then failing, for good. Well past the
 * longest provision: 3 minutes on another request's, then Neev's 10-minute
 * prepare; and past STALE_PROVISION_MS, after which the plan no longer counts
 * it.
 */
export const BOX_CLAIM_ABANDONED_AFTER_MS = 30 * 60_000;

export const BOX_CLAIM_ABANDONED_MESSAGE =
  "Starting this box stopped before it finished (Outrunner may have restarted while it ran).";

/**
 * What an abandoned claim on a box becomes, as its provision's own failure
 * would leave it (lib/runtime/ensure-runtime-computer.ts): stopped, still
 * naming the box it was bringing back, so the next open restores from that
 * box and its sessions; in error when it names none, so the next starts anew.
 */
export function abandonedBoxClaim(sandboxId: string | null): { status: "stopped" | "error"; errorMessage: string } {
  return { status: sandboxId ? "stopped" : "error", errorMessage: BOX_CLAIM_ABANDONED_MESSAGE };
}
