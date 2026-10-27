/**
 * Runs: what the Outrunner GitHub App's webhook does with a `pull_request`
 * event. It records one run for each enabled automation on the repository
 * whose trigger the event is (once per commit: the record's unique key), and
 * answers; then each run's session starts as the automation's runner
 * (startServerSession): on Outrunner's models, on the user's allowance, with
 * a token of the app's for the one repository, so what it posts is the
 * app's and it can't push.
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
  /** A token of the app's for the one repository: it comments, it can't push. */
  repositoryToken(installationId: number, repoFullName: string): Promise<string>;
  startServerSession(start: ServerSessionStart): Promise<ServerSessionResult>;
  settleRun(
    runId: string,
    outcome: { status: "started" | "ready" | "failed" | "refused"; workspaceId?: string | null; reason?: string | null },
  ): Promise<void>;
};

/** Start a run's session and keep how it went. Never throws: the run's
 *  record is all that hears of it. */
export async function startRun(run: PendingRun, deps: StartDeps): Promise<void> {
  const { candidate, event } = run;
  const settle = (outcome: Parameters<StartDeps["settleRun"]>[1]) =>
    deps.settleRun(run.runId, outcome).catch((error: unknown) => console.error(`Run ${run.runId} couldn't be kept`, error));
  if (!candidate.runsAs) {
    await settle({
      status: "refused",
      reason: "Whoever last changed this automation is no longer in the org. Save it to run it as you.",
    });
    return;
  }
  let token: string;
  try {
    token = await deps.repositoryToken(event.installationId, event.repoFullName);
  } catch (error) {
    console.error(`Run ${run.runId}: no token for ${event.repoFullName}`, error);
    await settle({ status: "refused", reason: "The Outrunner GitHub App couldn't get a token for this repository." });
    return;
  }
  const result = await deps.startServerSession({
    userId: candidate.runsAs,
    projectId: candidate.projectId,
    baseBranch: event.headRef,
    title: runTitle(candidate.name, event),
    prompt: runPrompt(candidate.prompt, event),
    githubToken: token,
  });
  await settle({
    status: result.status,
    workspaceId: result.workspaceId,
    reason: result.status === "ready" ? null : (result.errorMessage ?? null),
  });
}
