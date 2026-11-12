import {
  claimLease,
  clearWorkspaceNotices,
  closeInterval,
  type MeteredComputer,
  meteredReadyComputers,
  markStoppedIfReady,
  noticeWorkspace,
  openInterval,
  openIntervals,
  touchIntervals,
} from "@/lib/billing/metering-store";
import { SMALL_BOX_CPU } from "@/lib/billing/hours";
import { FORCED_PAUSE_NOTICE_PREFIX, LEASE_SECONDS, reconcile, type ReconcileReport } from "@/lib/billing/reconcile";
import { AgentClient, AgentRequestError } from "@/lib/runtime/agent-client";
import type { Activity } from "@/lib/runtime/agent-protocol";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider, platformProvider } from "@/lib/runtime/provider";

/**
 * One reconciler run (lib/billing/reconcile.ts) over every box on Outrunner's
 * accounts, each with the provider that made it: the deployment's, or the
 * one it moved from while that one's credentials are set (a Daytona box once
 * the deployment runs Neev). Never another provider's: asked about a box it
 * doesn't have, it would answer "gone", and the box's row would be marked
 * lost while the box ran on, unmetered.
 */
export async function runReconcile(): Promise<ReconcileReport> {
  const deployment = getRuntimeProvider();
  // A provider with no Runtime Computers (local, legacy Modal) has no boxes
  // Outrunner keeps running, so nothing to meter or pause.
  if (!isComputerProvider(deployment)) {
    return { skipped: true, seen: 0, paused: 0, forced: 0, lost: 0, closed: 0, failed: 0, deferred: 0 };
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
      return { running: true, ...(await activityOf(provider, computer)) };
    },
    pause: (computer) => makerOf(computer).pauseComputer(computer.sandboxId),
    markStopped: (computer, reason) => markStoppedIfReady(computer.id, computer.sandboxId, reason),
    noticeSession: (computer, notice) => noticeWorkspace(computer.workspaceId, notice),
    clearNotices: (computers) =>
      clearWorkspaceNotices(
        computers.flatMap((c) => (c.workspaceId ? [c.workspaceId] : [])),
        FORCED_PAUSE_NOTICE_PREFIX,
      ),
    keepAlive: (computer) => makerOf(computer).keepComputerAlive(computer.sandboxId),
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
    log: (message, error) => (error === undefined ? console.warn(message) : console.error(message, error)),
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

/** What the box's agent reports, and whether it answered at all. Null
 *  activity: it can't say, from before /activity (a 404: reachable) or not
 *  reached (a secret that won't open, no answer). Its box is then not paused
 *  as idle; one not reached is once it has said nothing for hours
 *  (UNREACHABLE_PAUSE_MS). */
async function activityOf(
  provider: ComputerRuntimeProvider,
  computer: MeteredComputer,
): Promise<{ activity: Activity | null; reachable: boolean }> {
  // A secret that won't open leaves the box's agent unreachable.
  if (!computer.agentSecret) return { activity: null, reachable: false };
  try {
    const target = await provider.agentTarget(computer.sandboxId, computer.agentSecret);
    const activity = await new AgentClient(target).activity({
      projectId: computer.projectId,
      computerId: computer.id,
      userId: computer.ownerId,
    });
    return { activity, reachable: true };
  } catch (error) {
    // Answered, without /activity: an agent from before it.
    if (error instanceof AgentRequestError && error.status === 404) return { activity: null, reachable: true };
    console.warn(`Reconcile: no activity from computer ${computer.id}'s agent`, error);
    return { activity: null, reachable: false };
  }
}
