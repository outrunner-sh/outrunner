/**
 * Real wiring for the warm pool (lib/runtime/warm-pool.ts). Kept apart so the
 * rules stay free of the database and unit-testable.
 */

import { randomBytes } from "node:crypto";

import { isMetered } from "@/lib/billing/metering-store";
import {
  claimPooledComputer,
  createPooledComputer,
  deletePooledComputer,
  getPooledComputer,
  updateRuntimeComputer,
} from "@/lib/db/repositories";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { refillPool } from "@/lib/runtime/warm-pool";
import type { Project } from "@/lib/runtime/types";

/** Whether `provider`'s boxes are pooled: Outrunner's own, on a provider
 *  that pauses a box and brings it back on its disk. */
export function poolsBoxes(provider: ComputerRuntimeProvider): boolean {
  return provider.pausesBoxes && provider.restoresBoxes && isMetered(provider.name);
}

/** The project's pooled box for a new session to take, made by `provider`:
 *  its id, or null when there's none (and so the session makes its own). */
export async function takePooledBox(provider: ComputerRuntimeProvider, workspaceId: string): Promise<string | null> {
  if (!poolsBoxes(provider)) return null;
  try {
    return await claimPooledComputer(workspaceId, provider.name);
  } catch (error) {
    console.error(`Could not take a pooled box for ${workspaceId}`, error);
    return null;
  }
}

/** Make the project's pooled box, for its next session, when it has none.
 *  Best effort, after a session's setup: it never throws. */
export async function refillProjectPool(input: {
  provider: ComputerRuntimeProvider;
  ownerId: string;
  project: Pick<Project, "id" | "fullName">;
  githubToken?: string;
  sessionEnv: Record<string, string>;
}): Promise<void> {
  const { provider, ownerId, project } = input;
  try {
    await refillPool({
      pools: poolsBoxes(provider),
      pooled: () => getPooledComputer(project.id),
      claimSlot: (secret) =>
        createPooledComputer({ ownerId, projectId: project.id, provider: provider.name, agentSecret: secret }),
      make: (secret) =>
        provider.provisionComputer({
          secret,
          repoFullName: project.fullName,
          githubToken: input.githubToken,
          sessionEnv: input.sessionEnv,
        }),
      pause: (sandboxId) => provider.pauseComputer(sandboxId),
      ready: (computerId, sandboxId) =>
        updateRuntimeComputer(computerId, { status: "stopped", daytonaSandboxId: sandboxId, errorMessage: null }),
      discard: (sandboxId) => provider.destroyComputerOrThrow(sandboxId),
      forget: deletePooledComputer,
      newSecret: () => randomBytes(32).toString("hex"),
    });
  } catch (error) {
    console.error(`Could not make ${project.fullName}'s pooled box`, error);
  }
}
