/**
 * Runs: what the Outrunner GitHub App's webhook does with a `pull_request`
 * event, and what the cron's tick does with a schedule come due. Each
 * records one run for each enabled automation it starts, on each repository
 * (once per commit, or per scheduled time: the record's unique key), and
 * answers; then each run's session starts as the automation's runner
 * (startServerSession): on Outrunner's models, on the user's allowance,
 * working on GitHub as the App (reading code, commenting on pull requests),
 * so what it posts is the App's and it can't push.
 */

import { type PullRequestEvent, readClosedPullRequest, readPullRequestEvent } from "@/lib/automations/pull-request";
import {
  eventBaseBranch,
  eventPrompt,
  eventTitle,
  isPullRequestEvent,
  type RunEvent,
  type ScheduleEvent,
} from "@/lib/automations/run-event";
import { describeSchedule, nextRun } from "@/lib/automations/schedule";
import type { DueSchedule, RerunTarget, RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";

/** A run recorded, to start. */
export type PendingRun = {
  runId: string;
  candidate: RunCandidate;
  event: RunEvent;
  /** The App's slug: its session is told which comments are its own. */
  appSlug?: string;
};

export type PlanDeps = {
  automationsForPullRequest(installationId: number, repoFullName: string): Promise<RunCandidate[]>;
  /** Record the runs, all or none: each new one's id by its automation and
   *  repository (`${automationId}:${projectId}`); one whose key is recorded
   *  already is left out. */
  recordRuns(runs: RunRecord[]): Promise<Map<string, string>>;
};

/** A pull request's run's record: once per commit, whichever of its
 *  triggers comes first. */
function pullRequestRecord(candidate: RunCandidate, event: PullRequestEvent): RunRecord {
  return {
    automationId: candidate.automationId,
    projectId: candidate.projectId,
    trigger: event.trigger,
    dedupeKey: `pr:${event.number}:${event.headSha}`,
    event,
    prNumber: event.number,
    prTitle: event.title,
    headSha: event.headSha,
  };
}

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
  const recorded = await deps.recordRuns(candidates.map((c) => pullRequestRecord(c, event)));
  return candidates.flatMap((candidate) => {
    const runId = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
    return runId ? [{ runId, candidate, event, appSlug }] : [];
  });
}

export type ScheduleDeps = {
  dueSchedules(now: Date): Promise<DueSchedule[]>;
  automationCandidates(automationIds: readonly string[]): Promise<RunCandidate[]>;
  recordRuns: PlanDeps["recordRuns"];
  /** Move a schedule on from `dueAt`, unless another tick has: false then. */
  advanceSchedule(scheduleId: string, dueAt: string, next: string | null): Promise<boolean>;
};

/**
 * The cron's tick: a run for each schedule come due, on each of its
 * automation's repositories, keyed by the time it was due, then the schedule
 * moved on to its next time after now. Recorded before it's moved on, so a
 * tick cut off between the two records the same keys again (nothing new)
 * and moves it on; and a tick that comes late runs a missed time once, then
 * goes on from now, never catching up on every time it missed. Two
 * schedules of one automation due at once run once. The runs to start.
 */
export async function planScheduledRuns(now: Date, deps: ScheduleDeps): Promise<PendingRun[]> {
  const due = await deps.dueSchedules(now);
  if (due.length === 0) return [];
  const candidates = await deps.automationCandidates([...new Set(due.map((d) => d.automationId))]);
  const pending: PendingRun[] = [];
  for (const slot of due) {
    const event: ScheduleEvent = {
      trigger: "schedule",
      scheduledFor: slot.dueAt,
      timezone: slot.schedule.timezone,
      description: describeSchedule(slot.schedule),
    };
    const mine = candidates.filter((c) => c.automationId === slot.automationId);
    try {
      const recorded = await deps.recordRuns(
        mine.map((c) => ({
          automationId: c.automationId,
          projectId: c.projectId,
          trigger: "schedule",
          dedupeKey: `schedule:${slot.dueAt}`,
          event,
          scheduledFor: slot.dueAt,
        })),
      );
      for (const candidate of mine) {
        const runId = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
        if (runId) pending.push({ runId, candidate, event });
      }
      const next = nextRun(slot.schedule, Math.max(now.getTime(), Date.parse(slot.dueAt)));
      await deps.advanceSchedule(slot.scheduleId, slot.dueAt, next === null ? null : new Date(next).toISOString());
    } catch (error) {
      // Left due: the next tick tries it again, and records nothing twice.
      console.error(`Schedule ${slot.scheduleId}: couldn't record its runs`, error);
    }
  }
  return pending;
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
  /** Open the run's check on its pull request (lib/automations/checks.ts),
   *  and close it without a review, saying why. Neither throws. */
  openCheck(run: PendingRun & { event: PullRequestEvent }): Promise<void>;
  closeCheck(runId: string, reason: string): Promise<void>;
};

/** Start a run's session and keep how it went. Never throws: the run's
 *  record is all that hears of it. */
export async function startRun(run: PendingRun, deps: StartDeps): Promise<void> {
  const { candidate, event } = run;
  const settle = (outcome: Parameters<StartDeps["settleRun"]>[1]) =>
    deps.settleRun(run.runId, outcome).catch((error: unknown) => console.error(`Run ${run.runId} couldn't be kept`, error));
  // A pull request's review has its check on the pull request from the
  // start (lib/automations/checks.ts): in progress until its review is
  // posted, or it can't be. Any other run has none.
  const checked = isPullRequestEvent(event);
  if (checked) await deps.openCheck({ ...run, event });
  const refuse = async (reason: string) => {
    await settle({ status: "refused", reason });
    if (checked) await deps.closeCheck(run.runId, reason);
  };
  // A team org's runs are its connector's: in no member's list, and paid by
  // the deployment on its own allowance. A personal org's, its owner's, who
  // set it up.
  let runner: string | null;
  try {
    runner = (await deps.orgConnector(candidate.orgId)) ?? candidate.runsAs;
  } catch (error) {
    console.error(`Run ${run.runId}: couldn't get the org's connector`, error);
    await refuse("Outrunner couldn't set up the org's connector to run it. It runs on the next commit.");
    return;
  }
  if (!runner) {
    await refuse("Whoever last changed this automation is no longer in the org. It runs again once an admin saves it.");
    return;
  }
  const result = await deps.startServerSession({
    userId: runner,
    projectId: candidate.projectId,
    baseBranch: eventBaseBranch(event),
    title: eventTitle(candidate.name, event),
    // Told its id, to mark its review with, when the review closes a check.
    prompt: eventPrompt(candidate.prompt, event, {
      repoFullName: candidate.repoFullName,
      appSlug: run.appSlug,
      runId: checked ? run.runId : undefined,
    }),
    // As the App, reading code and commenting, with tokens its box asks for
    // as it goes (#187's git-credential), so none expires on it mid-review.
    reviewAsApp: true,
    source: "automation",
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
  if (checked && result.status !== "ready") {
    await deps.closeCheck(run.runId, result.errorMessage ?? "Its session didn't start.");
  }
  // The newest review takes over: the earlier ones' sessions are archived (a
  // snapshot each, restorable), so the runner's list keeps the latest and
  // their boxes are freed. Only once it's ready: a failed run keeps them.
  // Runs set up side by side, so one ready after a later commit's run is
  // ready already is itself the stale one: it archives its own session
  // instead. (A later run still setting up archives this one when it's
  // ready; one that failed leaves this one open.) A schedule's runs each
  // stand on their own.
  if (isPullRequestEvent(event) && result.status === "ready" && result.workspaceId) {
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

export type CloseDeps = {
  /** The open sessions of the automations' runs on the pull request, by
   *  their owner (pullRequestSessions). */
  pullRequestSessions(installationId: number, repoFullName: string, prNumber: number): Promise<Map<string, string[]>>;
  archiveServerSessions(userId: string, workspaceIds: readonly string[]): Promise<number>;
  /** The runs on it whose check is still open (openChecksOfPullRequest). */
  openChecksOfPullRequest(installationId: number, repoFullName: string, prNumber: number): Promise<string[]>;
  closeCheck(runId: string, reason: string): Promise<void>;
};

/**
 * A pull request closed or merged: its review sessions are archived (a
 * snapshot each, restorable), as each one's runner, and their boxes freed.
 * How many were. Never throws: a session left open is only its box's idle
 * time, which pauses it anyway.
 */
export async function closeRuns(payload: unknown, deps: CloseDeps): Promise<number> {
  const closed = readClosedPullRequest(payload);
  if (!closed) return 0;
  try {
    // A review that never came won't now: its check says so.
    const open = await deps.openChecksOfPullRequest(closed.installationId, closed.repoFullName, closed.number);
    await Promise.all(open.map((runId) => deps.closeCheck(runId, "The pull request closed before its review was posted.")));
  } catch (error) {
    console.error(`Couldn't close the checks of ${closed.repoFullName}#${closed.number}`, error);
  }
  try {
    const byOwner = await deps.pullRequestSessions(closed.installationId, closed.repoFullName, closed.number);
    let archived = 0;
    for (const [owner, ids] of byOwner) archived += await deps.archiveServerSessions(owner, ids);
    return archived;
  } catch (error) {
    console.error(`Couldn't archive the review sessions of ${closed.repoFullName}#${closed.number}`, error);
    return 0;
  }
}

export type RerunDeps = {
  rerunTarget(orgId: string, runId: string): Promise<RerunTarget | null>;
  /** The pull request as GitHub has it now, read as the installation. */
  pullRequest(installationId: number, repoFullName: string, number: number): Promise<Record<string, unknown>>;
  reopenRun(runId: string): Promise<boolean>;
  recordRuns: PlanDeps["recordRuns"];
};

export type Rerun =
  | {
      ok: true;
      run: PendingRun;
      /** The session the run made before, to archive as it starts over:
       *  reopening it unlinks it, and a failed run's box may still be up. */
      staleSession: string | null;
    }
  | { ok: false; status: 404 | 409; error: string };

/** Why a suspended installation's run can't start: said by GitHub (a 403
 *  minting its token) or by its webhook (github_installations). */
export const SUSPENDED =
  "The GitHub App is suspended on this repository's account: unsuspend it on GitHub (the account's Settings → GitHub Apps) to run it.";

const SKIPPED: Record<Exclude<ReturnType<typeof readPullRequestEvent>, PullRequestEvent>, string> = {
  action: "The pull request can't be read from GitHub right now.",
  unreadable: "The pull request can't be read from GitHub right now.",
  draft: "The pull request is a draft: it runs once it's ready for review.",
  fork: "The pull request is from a fork, which automations don't run on.",
  bot: "The pull request is a bot's that automations don't run on.",
};

/**
 * An admin runs a run that failed or didn't start again: on the pull
 * request's head as GitHub has it now, so nothing older than it is reviewed.
 * At the same commit, the run itself starts over; at a later one (no run
 * there yet: the automation was off, say), a run is recorded for it. What to
 * start, or why not.
 */
export async function rerunRun(orgId: string, runId: string, deps: RerunDeps, appSlug?: string): Promise<Rerun> {
  const target = await deps.rerunTarget(orgId, runId);
  if (!target) return { ok: false, status: 404, error: "No such run." };
  if (target.status !== "failed" && target.status !== "refused") {
    return { ok: false, status: 409, error: "Only a run that failed or didn't start runs again." };
  }
  if (!target.enabled) return { ok: false, status: 409, error: "The automation is off: turn it on to run it." };
  if (!target.covered) {
    return { ok: false, status: 409, error: "The automation doesn't run on this repository any more." };
  }
  // Anything but a pull request's head starts over as it first would have:
  // the same run, told the same event (a schedule's time, say).
  if (target.prNumber === null) {
    if (!target.event) return { ok: false, status: 409, error: "This run can't be started again." };
    if (!(await deps.reopenRun(target.runId))) return { ok: false, status: 409, error: "It's running again already." };
    return { ok: true, run: { runId: target.runId, candidate: target.candidate, event: target.event, appSlug }, staleSession: target.workspaceId };
  }
  if (target.installationSuspended) {
    return { ok: false, status: 409, error: SUSPENDED };
  }
  if (target.installationId === null) {
    return { ok: false, status: 409, error: "The GitHub App isn't installed on this repository's account." };
  }
  const pr = await deps.pullRequest(target.installationId, target.repoFullName, target.prNumber);
  if (pr.state !== "open") return { ok: false, status: 409, error: "The pull request is closed." };
  // Read as a newly opened one: its session isn't told of commits since an
  // earlier look, which may have been none. Its repository's name is the
  // pull request's own, as GitHub has it now: one renamed since (GitHub
  // redirects) isn't taken for a fork.
  const event = readPullRequestEvent({ action: "opened", installation: { id: target.installationId }, pull_request: pr }, appSlug);
  if (typeof event === "string") return { ok: false, status: 409, error: SKIPPED[event] };
  if (event.headSha === target.headSha) {
    if (!(await deps.reopenRun(target.runId))) {
      return { ok: false, status: 409, error: "It's running again already." };
    }
    return {
      ok: true,
      run: { runId: target.runId, candidate: target.candidate, event, appSlug },
      staleSession: target.workspaceId,
    };
  }
  // Whatever the automation's triggers: an admin asked for it to run, and
  // the head's commit is the one to look at now (one that triggers only on
  // opened still runs here).
  const recorded = await deps.recordRuns([pullRequestRecord(target.candidate, event)]);
  const newId = recorded.get(`${target.candidate.automationId}:${target.candidate.projectId}`);
  if (!newId) {
    return { ok: false, status: 409, error: "The pull request has newer commits, with their own run: run that one again instead." };
  }
  // The failed run keeps its session, if it made one: the new run archives
  // it as an earlier one once it's ready (runNeighbours).
  return { ok: true, run: { runId: newId, candidate: target.candidate, event, appSlug }, staleSession: null };
}
