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
 * waiting first, and a slow setup that is still going is left alone.
 */
export const SETUP_INTERRUPTED_AFTER_MS = 20 * 60_000;

/** What the session page says of a setup cut off. */
export const SETUP_INTERRUPTED_MESSAGE =
  "Setup was interrupted before it finished (Outrunner restarted while it ran). Try again to start a fresh session.";

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
