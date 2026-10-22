/**
 * Real wiring for pausing a project's box once no session needs it
 * (lib/billing/release-box.ts). Kept apart so the rule stays free of the
 * database and unit-testable.
 */

import { closeIntervalOf, isMetered, markStoppedIfReady } from "@/lib/billing/metering-store";
import { releaseBoxIfUnused } from "@/lib/billing/release-box";
import { getRuntimeComputerByProject, listWorkspaces } from "@/lib/db/repositories";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { computerMadeBy } from "@/lib/runtime/sandbox-choice";

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
