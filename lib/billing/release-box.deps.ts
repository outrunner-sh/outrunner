/**
 * Real wiring for letting a box go once no session needs it
 * (lib/billing/release-box.ts): pausing a project's shared box, or a
 * session's own box when it is archived, and deleting a session's own box
 * when it ends. Kept apart so the rules stay free of the database and
 * unit-testable.
 */

import { closeIntervalOf, isMetered, markStoppedIfReady } from "@/lib/billing/metering-store";
import { deleteOwnBox, releaseBoxIfUnused } from "@/lib/billing/release-box";
import { getRuntimeComputerByProject, getWorkspaceComputer, listWorkspaces, updateRuntimeComputer } from "@/lib/db/repositories";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { ownBox } from "@/lib/runtime/computer-scope";
import { computerMadeBy } from "@/lib/runtime/sandbox-choice";
import type { Workspace } from "@/lib/runtime/types";

/**
 * Let the box of a session just archived or ended go: its own box is paused
 * (archived: Restore brings it back on its disk) or deleted (ended: nothing
 * comes back to it); a shared box is paused once none of its project's
 * sessions needs it. Best effort, as releaseProjectBox.
 */
export async function releaseWorkspaceBox(
  provider: ComputerRuntimeProvider,
  workspace: Pick<Workspace, "id" | "projectId" | "computerId">,
  ended: boolean,
): Promise<void> {
  let computer;
  try {
    computer = await getWorkspaceComputer(workspace);
  } catch (error) {
    console.error(`Could not find workspace ${workspace.id}'s box`, error);
    return;
  }
  if (!computer) return;
  if (!ownBox(computer)) return releaseProjectBox(provider, workspace.projectId);
  // Only a box this provider made: another's is retired where the user moved.
  if (computerMadeBy(computer) !== provider.name) return;
  try {
    if (ended) {
      // Every box of its own, Outrunner's or the user's: it was made for
      // this session alone, and left behind would only cost them.
      await deleteOwnBox({
        computer: async () => computer,
        delete: (sandboxId) => provider.destroyComputer(sandboxId),
        closeInterval: closeIntervalOf,
        markDeleted: (computerId) =>
          updateRuntimeComputer(computerId, {
            status: "stopped",
            daytonaSandboxId: null,
            agentBaseUrl: null,
            errorMessage: "Deleted with its session.",
          }),
        now: () => new Date(),
      });
      return;
    }
    // Archived: paused as the shared box is, Outrunner's only.
    if (!isMetered(computer.provider)) return;
    await releaseBoxIfUnused({
      pausesBoxes: provider.pausesBoxes,
      computer: async () => computer,
      sessions: async () => [{ status: "archived" }],
      pause: (sandboxId) => provider.pauseComputer(sandboxId),
      closeInterval: closeIntervalOf,
      markStopped: (computerId, sandboxId) =>
        markStoppedIfReady(computerId, sandboxId, "Paused with its session archived; Restore brings it back."),
      now: () => new Date(),
    });
  } catch (error) {
    console.error(`Could not let workspace ${workspace.id}'s box go`, error);
  }
}

/** Pause `projectId`'s box if none of its sessions needs it. Best effort: it
 *  runs after a session was archived or ended, which stands either way, so
 *  it never throws; a box left running is the reconciler's to pause. */
export async function releaseProjectBox(provider: ComputerRuntimeProvider, projectId: string): Promise<void> {
  try {
    await releaseBoxIfUnused({
      pausesBoxes: provider.pausesBoxes,
      computer: async () => {
        const computer = await getRuntimeComputerByProject(projectId);
        // Only Outrunner's boxes, as the reconciler: the user's own Daytona or
        // Modal is theirs to stop. And only one this provider can pause.
        return computer && computerMadeBy(computer) === provider.name && isMetered(computer.provider)
          ? computer
          : null;
      },
      sessions: () => listWorkspaces(projectId),
      pause: (sandboxId) => provider.pauseComputer(sandboxId),
      closeInterval: closeIntervalOf,
      markStopped: (computerId, sandboxId) =>
        markStoppedIfReady(computerId, sandboxId, "Paused with no sessions left; it resumes with the next session."),
      now: () => new Date(),
    });
  } catch (error) {
    console.error(`Could not pause project ${projectId}'s box`, error);
  }
}
