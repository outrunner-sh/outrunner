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
import { getRuntimeProvider } from "@/lib/runtime/provider";

/** One reconciler run on this deployment's provider (lib/billing/reconcile.ts). */
export async function runReconcile(): Promise<ReconcileReport> {
  const provider = getRuntimeProvider();
  // A provider with no Runtime Computers (local, legacy Modal) has no boxes
  // Outrunner keeps running, so nothing to meter or pause.
  if (!isComputerProvider(provider)) {
    return { skipped: true, seen: 0, paused: 0, forced: 0, lost: 0, closed: 0, failed: 0, deferred: 0 };
  }
  return reconcile({
    // Metered either way; paused only where a paused box comes back.
    pausesIdleBoxes: provider.pausesBoxes,
    now: () => new Date(),
    claimLease: () => claimLease("reconcile", LEASE_SECONDS),
    readyComputers: meteredReadyComputers,
    openIntervals,
    observe: async (computer) => {
      if (!(await provider.computerRunning(computer.sandboxId))) return { running: false };
      return { running: true, ...(await activityOf(provider, computer)) };
    },
    pause: (computer) => provider.pauseComputer(computer.sandboxId),
    markStopped: (computer, reason) => markStoppedIfReady(computer.id, computer.sandboxId, reason),
    noticeSession: (computer, notice) => noticeWorkspace(computer.workspaceId, notice),
    clearNotices: (computers) =>
      clearWorkspaceNotices(
        computers.flatMap((c) => (c.workspaceId ? [c.workspaceId] : [])),
        FORCED_PAUSE_NOTICE_PREFIX,
      ),
    keepAlive: (computer) => provider.keepComputerAlive(computer.sandboxId),
    // A provision opens its box's interval; this is for a box from before
    // metering, at the size its provider reports (Small where it can't say).
    openInterval: async (computer, at) =>
      openInterval({
        computerId: computer.id,
        sandboxId: computer.sandboxId,
        cpu: (await provider.computerCpu(computer.sandboxId)) ?? SMALL_BOX_CPU,
        at,
      }),
    touchIntervals,
    closeInterval,
    log: (message, error) => (error === undefined ? console.warn(message) : console.error(message, error)),
  });
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
