/**
 * How a run starts (lib/automations/runs.ts, startRun): its session as the
 * automation's runner, working on GitHub as the App (its box asks for the
 * App's tokens as it goes). The webhook's runs, the tick's, and an admin's
 * run again.
 */

import { closeRunCheckWithout, openRunCheck } from "@/lib/automations/checks.deps";
import { orgConnector } from "@/lib/automations/connector";
import type { StartDeps } from "@/lib/automations/runs";
import { claimQueuedRuns, queuedUntil, reusableSession, runNeighbours, settleRun } from "@/lib/db/automation-runs";
import { archiveServerSessions, startServerSession } from "@/lib/session/server-session";
import { wakeAndSend } from "@/lib/slack/research";

/** The longest one sleep of a run's wait: its window may be moved on
 *  meanwhile, and is read again after. */
const WAIT_STEP_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until the run's window has passed, read again after each sleep (a
 *  later trigger moves it on), then take it; the tick takes any whose wait
 *  a restart cut off. */
async function waitOutWindow(runId: string): ReturnType<StartDeps["waitOutWindow"]> {
  for (;;) {
    const until = await queuedUntil(runId);
    if (!until) return null;
    const left = Date.parse(until) - Date.now();
    if (left > 0) {
      await sleep(Math.min(left + 250, WAIT_STEP_MS));
      continue;
    }
    const [claimed] = await claimQueuedRuns(new Date(), runId);
    if (!claimed) return null;
    if (!claimed.event) {
      await settleRun(runId, { status: "refused", reason: "Its event couldn't be read back to start it." });
      return null;
    }
    return { event: claimed.event, combined: claimed.combined };
  }
}

export function startDeps(): StartDeps {
  return {
    startServerSession,
    settleRun,
    runNeighbours,
    archiveServerSessions,
    orgConnector,
    openCheck: openRunCheck,
    closeCheck: closeRunCheckWithout,
    waitOutWindow,
    reusableSession,
    // The way the Slack agent gives its thread's session a question:
    // resumed if its box was paused, restored if it was archived.
    continueSession: (userId, workspaceId, prompt) => wakeAndSend(userId, workspaceId, prompt),
    // A Mission's: its request, never a session (lib/missions/automation-target.ts).
    startMissionRun: async (run) => {
      const { runForMission } = await import("@/lib/missions/automation-target.deps");
      await runForMission(run);
    },
  };
}
