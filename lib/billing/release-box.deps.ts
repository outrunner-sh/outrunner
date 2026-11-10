/**
 * Real wiring for letting a box go once no session needs it
 * (lib/billing/release-box.ts): pausing a project's shared box, or a
 * session's own box when it is archived, and deleting a session's own box
 * when it ends. Kept apart so the rules stay free of the database and
 * unit-testable.
 */

import { closeIntervalOf, isMetered, markStoppedIfReady } from "@/lib/billing/metering-store";
import { deleteOwnBox, ownBoxDeleted, releaseBoxIfUnused } from "@/lib/billing/release-box";
import { ownSandboxKeys } from "@/lib/db/credentials";
import { getRuntimeComputerByProject, getWorkspaceComputer, listWorkspaces, updateRuntimeComputer } from "@/lib/db/repositories";
import { isComputerProvider, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { ownBox } from "@/lib/runtime/computer-scope";
import { computerMadeBy, providerNamed } from "@/lib/runtime/sandbox-choice";
import type { Workspace } from "@/lib/runtime/types";

/**
 * Let the box of a session just archived or ended go. Its own box is
 * deleted when the session ends (nothing comes back to it), and paused when
 * it is archived (Restore brings it back on its disk) or deleted where it
 * can't be paused (Restore rebuilds from the Snapshot). A shared box is
 * paused once none of its project's sessions needs it. Always with the
 * provider that made the box, which a session's own box may not share with
 * where the user's sessions go now. Best effort, as releaseProjectBox.
 */
export async function releaseWorkspaceBox(
  provider: ComputerRuntimeProvider,
  workspace: Pick<Workspace, "id" | "ownerId" | "projectId" | "computerId">,
  ended: boolean,
  /** Delete its own box though the session was only archived: its Snapshot
   *  is saved, and Restore rebuilds from it. */
  options: { dropBox?: boolean } = {},
): Promise<void> {
  try {
    const computer = await getWorkspaceComputer(workspace);
    if (!computer) return;
    if (!ownBox(computer)) return releaseProjectBox(provider, workspace.projectId);
    const madeBy = computerMadeBy(computer);
    const maker = madeBy === provider.name ? provider : providerNamed(madeBy, ownSandboxKeys(workspace.ownerId));
    if (!maker || !isComputerProvider(maker)) {
      console.error(`Workspace ${workspace.id}'s box is ${madeBy}'s, which can't be reached to let it go`);
      return;
    }
    // Every box of its own, Outrunner's or the user's: it was made for this
    // session alone, and left running would only cost them.
    const remove = () =>
      deleteOwnBox({
        computer: async () => computer,
        delete: (sandboxId) => maker.destroyComputerOrThrow(sandboxId),
        closeInterval: closeIntervalOf,
        markDeleted: (computerId) =>
          updateRuntimeComputer(computerId, {
            status: "stopped",
            daytonaSandboxId: null,
            agentBaseUrl: null,
            errorMessage: ended ? "Deleted with its session." : "Deleted with its session archived; Restore makes a new one.",
          }),
        now: () => new Date(),
      });
    if (ownBoxDeleted({ ended, dropBox: options.dropBox, pausesBoxes: maker.pausesBoxes })) {
      await remove();
      return;
    }
    await releaseBoxIfUnused({
      pausesBoxes: true,
      computer: async () => computer,
      sessions: async () => [{ status: "archived" }],
      pause: (sandboxId) => maker.pauseComputer(sandboxId),
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
      sessions: () => listWorkspaces({ projectId }),
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
