/**
 * A box no session needs any more is paused as soon as its last session is
 * archived or ended, instead of holding one of the plan's slots
 * (lib/billing/limits.ts), and costing, until the reconciler finds it idle
 * 15 minutes later (lib/billing/reconcile.ts). It is paused as the reconciler
 * pauses one: the box keeps its disk, its interval ends, and its computer is
 * marked stopped, so the next session brings it back.
 *
 * The I/O is behind {@link ReleaseBoxDeps}, so the rule is tested alone; the
 * wiring is release-box.deps.ts.
 */

import type { RuntimeComputer, Workspace, WorkspaceStatus } from "@/lib/runtime/types";

/** A session in one of these needs no box: an archived one's Snapshot is what
 *  Restore uses, and a failed or destroyed one has nothing running. Any other
 *  keeps the box: one running, one suspended (resume needs the box up), or
 *  one mid-change (an archive still under way pauses the box itself when it
 *  lands, if it is the last). */
const BOXLESS: ReadonlySet<WorkspaceStatus> = new Set(["archived", "failed", "destroyed"]);

export type ReleaseBoxDeps = {
  /** Whether the provider can pause a box and bring it back. */
  pausesBoxes: boolean;
  /** The project's computer, when it is one to pause: made by this provider,
   *  on a box Outrunner pays for. */
  computer(): Promise<Pick<RuntimeComputer, "id" | "status" | "daytonaSandboxId"> | null>;
  /** The project's sessions. */
  sessions(): Promise<Pick<Workspace, "status">[]>;
  pause(sandboxId: string): Promise<void>;
  /** End the box's open interval, if it has one. */
  closeInterval(sandboxId: string, at: Date): Promise<void>;
  /** Mark the computer stopped, keeping its box id, if it is still the ready
   *  one on that box. */
  markStopped(computerId: string, sandboxId: string): Promise<void>;
  now(): Date;
};

/** Whether any of a project's sessions still needs its box. */
export function boxNeeded(sessions: readonly Pick<Workspace, "status">[]): boolean {
  return sessions.some((session) => !BOXLESS.has(session.status));
}

/**
 * Pause the project's box when none of its sessions needs it. Whether it was
 * paused.
 *
 * A session started on the project in the moment between the look and the
 * pause is in the same spot as one started just as the reconciler pauses a
 * box: its next request finds the box paused and brings it back, though a
 * setup caught mid-way fails and is started again.
 */
export async function releaseBoxIfUnused(deps: ReleaseBoxDeps): Promise<boolean> {
  if (!deps.pausesBoxes) return false;
  const computer = await deps.computer();
  if (computer?.status !== "ready" || !computer.daytonaSandboxId) return false;
  if (boxNeeded(await deps.sessions())) return false;
  const sandboxId = computer.daytonaSandboxId;
  await deps.pause(sandboxId);
  await deps.closeInterval(sandboxId, deps.now());
  await deps.markStopped(computer.id, sandboxId);
  return true;
}
