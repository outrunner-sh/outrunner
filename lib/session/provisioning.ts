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
