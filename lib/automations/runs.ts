/**
 * Runs: what the Outrunner GitHub App's webhook does with a `pull_request`
 * event. It records one run for each enabled automation on the repository
 * whose trigger the event is (once per commit: the record's unique key), and
 * answers; then each run's session starts as the automation's runner
 * (startServerSession): on Outrunner's models, on the user's allowance,
 * working on GitHub as the App (reading code, commenting on pull requests),
 * so what it posts is the App's and it can't push.
 */

import { type PullRequestEvent, readPullRequestEvent, runPrompt, runTitle } from "@/lib/automations/pull-request";
import type { RunCandidate } from "@/lib/db/automation-runs";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";

/** A run recorded, to start. */
export type PendingRun = { runId: string; candidate: RunCandidate; event: PullRequestEvent };

export type PlanDeps = {
  automationsForPullRequest(installationId: number, repoFullName: string): Promise<RunCandidate[]>;
  /** Record the runs, all or none: each new one's id by its automation and
   *  repository (`${automationId}:${projectId}`); one already run at this
   *  commit is left out. */
  recordRuns(
    runs: { automationId: string; projectId: string; prNumber: number; prTitle: string; headSha: string }[],
  ): Promise<Map<string, string>>;
};

/** Record the runs an event starts, in one write, so a failure records none
 *  and GitHub's redelivery starts them all; what's recorded is to start.
 *  Nothing for an event that starts none, or one already run at this commit. */
export async function planRuns(payload: unknown, deps: PlanDeps, appSlug?: string): Promise<PendingRun[]> {
  const event = readPullRequestEvent(payload, appSlug);
  if (typeof event === "string") return [];
  const candidates = (await deps.automationsForPullRequest(event.installationId, event.repoFullName)).filter((c) =>
    c.triggers.includes(event.trigger),
  );
  if (candidates.length === 0) return [];
  const recorded = await deps.recordRuns(
    candidates.map((c) => ({
      automationId: c.automationId,
      projectId: c.projectId,
      prNumber: event.number,
      prTitle: event.title,
      headSha: event.headSha,
    })),
  );
  return candidates.flatMap((candidate) => {
    const runId = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
    return runId ? [{ runId, candidate, event }] : [];
  });
}

export type StartDeps = {
  startServerSession(start: ServerSessionStart): Promise<ServerSessionResult>;
  settleRun(
    runId: string,
    outcome: { status: "started" | "ready" | "failed" | "refused"; workspaceId?: string | null; reason?: string | null },
  ): Promise<void>;
  /** The sessions of this automation's earlier runs on the pull request, and
   *  whether a later run is ready already (runNeighbours). */
  runNeighbours(run: {
    runId: string;
    automationId: string;
    projectId: string;
    prNumber: number;
  }): Promise<{ earlierSessions: string[]; superseded: boolean }>;
  /** Archive them as the runner; how many were. */
  archiveServerSessions(userId: string, workspaceIds: readonly string[]): Promise<number>;
  /** The org's connector (lib/automations/connector.ts), made if need be;
   *  null for a personal org, which has none. */
  orgConnector(orgId: string): Promise<string | null>;
};

/** Start a run's session and keep how it went. Never throws: the run's
 *  record is all that hears of it. */
export async function startRun(run: PendingRun, deps: StartDeps): Promise<void> {
  const { candidate, event } = run;
  const settle = (outcome: Parameters<StartDeps["settleRun"]>[1]) =>
    deps.settleRun(run.runId, outcome).catch((error: unknown) => console.error(`Run ${run.runId} couldn't be kept`, error));
  // A team org's runs are its connector's: in no member's list, and paid by
  // the deployment on its own allowance. A personal org's, its owner's, who
  // set it up.
  let runner: string | null;
  try {
    runner = (await deps.orgConnector(candidate.orgId)) ?? candidate.runsAs;
  } catch (error) {
    console.error(`Run ${run.runId}: couldn't get the org's connector`, error);
    await settle({ status: "refused", reason: "Outrunner couldn't set up the org's connector to run it. It runs on the next commit." });
    return;
  }
  if (!runner) {
    await settle({
      status: "refused",
      reason: "Whoever last changed this automation is no longer in the org. It runs again once an admin saves it.",
    });
    return;
  }
  const result = await deps.startServerSession({
    userId: runner,
    projectId: candidate.projectId,
    baseBranch: event.headRef,
    title: runTitle(candidate.name, event),
    prompt: runPrompt(candidate.prompt, event),
    // As the App, reading code and commenting, with tokens its box asks for
    // as it goes (#187's git-credential), so none expires on it mid-review.
    reviewAsApp: true,
    // Linked to the run as soon as it's made: its box's token requests are
    // answered as the App's from the first.
    onCreated: async (workspaceId) => {
      await deps.settleRun(run.runId, { status: "started", workspaceId });
    },
  });
  await settle({
    status: result.status,
    workspaceId: result.workspaceId,
    reason: result.status === "ready" ? null : (result.errorMessage ?? null),
  });
  // The newest review takes over: the earlier ones' sessions are archived (a
  // snapshot each, restorable), so the runner's list keeps the latest and
  // their boxes are freed. Only once it's ready: a failed run keeps them.
  // Runs set up side by side, so one ready after a later commit's run is
  // ready already is itself the stale one: it archives its own session
  // instead. (A later run still setting up archives this one when it's
  // ready; one that failed leaves this one open.)
  if (result.status === "ready" && result.workspaceId) {
    try {
      const { earlierSessions, superseded } = await deps.runNeighbours({
        runId: run.runId,
        automationId: candidate.automationId,
        projectId: candidate.projectId,
        prNumber: event.number,
      });
      await deps.archiveServerSessions(runner, superseded ? [result.workspaceId] : earlierSessions);
    } catch (error) {
      console.error(`Run ${run.runId}: couldn't archive the earlier review sessions`, error);
    }
  }
}
