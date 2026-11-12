import {
  claimLease,
  closeInterval,
  type MeteredComputer,
  meteredReadyComputers,
  markStoppedIfReady,
  openInterval,
  openIntervals,
  touchIntervals,
} from "@/lib/billing/metering-store";
import { SMALL_BOX_CPU } from "@/lib/billing/hours";
import { LEASE_SECONDS, reconcile, type ReconcileReport } from "@/lib/billing/reconcile";
import { AgentClient } from "@/lib/runtime/agent-client";
import type { Activity } from "@/lib/runtime/agent-protocol";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider, platformProvider } from "@/lib/runtime/provider";

/**
 * One reconciler run (lib/billing/reconcile.ts) over every box on Outrunner's
 * accounts, each with the provider that made it: the deployment's, or one it
 * moved from while that one's credentials are set (a Daytona box once the
 * deployment runs E2B). Never another provider's: asked about a box it
 * doesn't have, it would answer "gone", and the box's row would be marked
 * stopped while the box ran on, unmetered.
 */
export async function runReconcile(): Promise<ReconcileReport> {
  const deployment = getRuntimeProvider();
  // A provider with no Runtime Computers (local, legacy Modal) has no boxes
  // Outrunner keeps running, so nothing to meter or pause.
  if (!isComputerProvider(deployment)) {
    return { skipped: true, seen: 0, paused: 0, lost: 0, closed: 0, failed: 0, deferred: 0 };
  }
  return reconcile({
    // Metered either way; paused only where a paused box comes back.
    pausesIdleBoxes: deployment.pausesBoxes,
    now: () => new Date(),
    claimLease: () => claimLease("reconcile", LEASE_SECONDS),
    readyComputers: meteredReadyComputers,
    openIntervals,
    observe: async (computer) => {
      const provider = makerOf(computer);
      if (!(await provider.computerRunning(computer.sandboxId))) return { running: false };
      return { running: true, activity: await activityOf(provider, computer) };
    },
    pause: (computer) => makerOf(computer).pauseComputer(computer.sandboxId),
    markStopped: (computer, reason) => markStoppedIfReady(computer.id, computer.sandboxId, reason),
    // A provision opens its box's interval; this is for a box from before
    // metering, at the size its provider reports (Small where it can't say).
    openInterval: async (computer, at) =>
      openInterval({
        computerId: computer.id,
        sandboxId: computer.sandboxId,
        cpu: (await makerOf(computer).computerCpu(computer.sandboxId)) ?? SMALL_BOX_CPU,
        at,
      }),
    touchIntervals,
    closeInterval,
    log: (message, error) => console.error(message, error),
  });
}

/** The provider that made `computer`'s box. A throw where this deployment
 *  can't reach it (its credentials were removed): the box is counted failed
 *  and left as it is, never taken for gone. */
function makerOf(computer: MeteredComputer): ComputerRuntimeProvider {
  const provider = platformProvider(computer.provider);
  if (!provider || !isComputerProvider(provider)) {
    throw new Error(`Its box is on ${computer.provider}, which this deployment has no credentials for`);
  }
  return provider;
}

/** What the box's agent reports, or null when it can't say: one from before
 *  /activity (404) or one that can't be reached. Its box is then not paused. */
async function activityOf(provider: ComputerRuntimeProvider, computer: MeteredComputer): Promise<Activity | null> {
  // A secret that won't open leaves the box's agent unreachable.
  if (!computer.agentSecret) return null;
  try {
    const target = await provider.agentTarget(computer.sandboxId, computer.agentSecret);
    return await new AgentClient(target).activity({
      projectId: computer.projectId,
      computerId: computer.id,
      userId: computer.ownerId,
    });
  } catch (error) {
    console.warn(`Reconcile: no activity from computer ${computer.id}'s agent`, error);
    return null;
  }
}
