import type { RuntimeComputer } from "@/lib/runtime/types";

/**
 * Whose box a Runtime Computer is: one workspace's own, or a project's shared
 * by its sessions. Every new session gets a box of its own
 * (20261023130000_workspace_computers.sql). A project's shared box is from
 * before then: a session already on one stays on it, so nothing about it
 * changes, and no new session joins it.
 */
export type ComputerScope = { workspaceId: string } | { projectId: string };

/** The scope a workspace's box is claimed and found in: the shared box it is
 *  on, if it is on one, else its own. */
export function scopeOf(
  workspace: { id: string },
  computer: Pick<RuntimeComputer, "projectId" | "workspaceId"> | null,
): ComputerScope {
  return computer && computer.workspaceId === null
    ? { projectId: computer.projectId }
    : { workspaceId: workspace.id };
}

/** Whether `computer` is the box of `scope`. */
export function inScope(
  computer: Pick<RuntimeComputer, "projectId" | "workspaceId">,
  scope: ComputerScope,
): boolean {
  return "workspaceId" in scope
    ? computer.workspaceId === scope.workspaceId
    : computer.workspaceId === null && computer.projectId === scope.projectId;
}

/** Whether the box is a workspace's own, which goes when its session does. */
export function ownBox(computer: Pick<RuntimeComputer, "workspaceId">): boolean {
  return computer.workspaceId !== null;
}
