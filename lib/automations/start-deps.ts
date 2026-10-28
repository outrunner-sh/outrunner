/**
 * How a run starts (lib/automations/runs.ts, startRun): its session as the
 * automation's runner, working on GitHub as the App (its box asks for the
 * App's tokens as it goes). The webhook's runs, and an admin's run again.
 */

import { closeRunCheckWithout, openRunCheck } from "@/lib/automations/checks.deps";
import { orgConnector } from "@/lib/automations/connector";
import type { StartDeps } from "@/lib/automations/runs";
import { runNeighbours, settleRun } from "@/lib/db/automation-runs";
import { archiveServerSessions, startServerSession } from "@/lib/session/server-session";

export function startDeps(): StartDeps {
  return {
    startServerSession,
    settleRun,
    runNeighbours,
    archiveServerSessions,
    orgConnector,
    openCheck: openRunCheck,
    closeCheck: closeRunCheckWithout,
  };
}
