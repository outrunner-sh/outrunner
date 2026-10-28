/**
 * Runs: what the Outrunner GitHub App's webhook does with a `pull_request`
 * or `issues` event, and what the cron's tick does with a schedule come due.
 * Each records one run for each enabled automation it starts, on each
 * repository (once per key: a commit, an event, a scheduled time), within
 * the automation's limits (record_automation_runs: how many times it runs,
 * and a debounce window that combines triggers into one run, which waits it
 * out), and answers; then each run's session starts as the automation's runner
 * (startServerSession): on Outrunner's models, on the user's allowance,
 * working on GitHub as the App (reading code, commenting on pull requests),
 * so what it posts is the App's and it can't push.
 */

import { eventDedupeKey, filtersTake, type IssueEvent, readIssueEvent } from "@/lib/automations/github-events";
import { atHead, type PullRequestEvent, readClosedPullRequest, readPullRequestEvent } from "@/lib/automations/pull-request";
import {
  eventBaseBranch,
  eventPrompt,
  eventSubject,
  eventTitle,
  isIssueEvent,
  isPullRequestEvent,
  type RunEvent,
  type ScheduleEvent,
} from "@/lib/automations/run-event";
import { describeSchedule, nextRun } from "@/lib/automations/schedule";
import type {
  ClaimedRun,
  DueSchedule,
  Recorded,
  RerunTarget,
  RunCandidate,
  RunRecord,
} from "@/lib/db/automation-runs";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";

/** A run recorded, to start. */
export type PendingRun = {
  runId: string;
  candidate: RunCandidate;
  event: RunEvent;
  /** The App's slug: its session is told which comments are its own. */
  appSlug?: string;
  /** It waits out its automation's debounce window before it starts (and
   *  may take in triggers that come meanwhile). */
  queued?: boolean;
  /** How many triggers its window combined into it. */
  combined?: number;
};

export type PlanDeps = {
  /** The enabled automations on a repository, through the installation an
   *  event came by: a pull request's, or an issue's. */
  automationsForPullRequest(installationId: number, repoFullName: string): Promise<RunCandidate[]>;
  /** Record the runs, all or none: each by its automation and repository
   *  (`${automationId}:${projectId}`), new or a waiting run it was combined
   *  into; one whose key is recorded already, or past its automation's
   *  limit, is left out. */
  recordRuns(runs: RunRecord[]): Promise<Map<string, Recorded>>;
};

/** A run's record: what started it, the key that makes it once, and what a
 *  debounce window combines it on. */
export function recordOf(candidate: Pick<RunCandidate, "automationId" | "projectId">, event: RunEvent, dedupeKey: string): RunRecord {
  return {
    automationId: candidate.automationId,
    projectId: candidate.projectId,
    trigger: event.trigger,
    dedupeKey,
    subject: eventSubject(event),
    event,
    ...(isPullRequestEvent(event) ? { prNumber: event.number, prTitle: event.title, headSha: event.headSha } : {}),
    ...(isIssueEvent(event) ? { issueNumber: event.number, prTitle: event.title } : {}),
    ...(event.trigger === "schedule" ? { scheduledFor: event.scheduledFor } : {}),
  };
}

/** The runs recorded for `candidates`, to start (or to wait out a window). */
function pendingOf(
  candidates: readonly RunCandidate[],
  recorded: ReadonlyMap<string, Recorded>,
  event: RunEvent,
  appSlug?: string,
): PendingRun[] {
  return candidates.flatMap((candidate) => {
    const run = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
    return run ? [{ runId: run.runId, candidate, event, appSlug, ...(run.queued ? { queued: true } : {}) }] : [];
  });
}

/** Record the runs a GitHub event starts: each automation on the repository
 *  with its trigger, and whose filters take it (a review requested of one of
 *  its reviewers, one of its labels). */
async function planEventRuns(
  event: PullRequestEvent | IssueEvent,
  deps: PlanDeps,
  appSlug: string | undefined,
  delivery: string | null,
): Promise<PendingRun[]> {
  const candidates = (await deps.automationsForPullRequest(event.installationId, event.repoFullName)).filter(
    (c) => c.triggers.includes(event.trigger) && filtersTake(c, event),
  );
  if (candidates.length === 0) return [];
  const key = eventDedupeKey(event, delivery);
  const recorded = await deps.recordRuns(candidates.map((c) => recordOf(c, event, key)));
  return pendingOf(candidates, recorded, event, appSlug);
}

/** Record the runs a `pull_request` event starts, in one write, so a
 *  failure records none and GitHub's redelivery (`delivery`, its
 *  X-GitHub-Delivery) starts them all; what's recorded is to start. Nothing
 *  for an event that starts none, or one already run. */
export async function planRuns(payload: unknown, deps: PlanDeps, appSlug?: string, delivery: string | null = null): Promise<PendingRun[]> {
  const event = readPullRequestEvent(payload, appSlug);
  if (typeof event === "string") return [];
  return planEventRuns(event, deps, appSlug, delivery);
}

/** The same for an `issues` event: opened, or labeled. */
export async function planIssueRuns(payload: unknown, deps: PlanDeps, appSlug?: string, delivery: string | null = null): Promise<PendingRun[]> {
  const event = readIssueEvent(payload, appSlug);
  if (typeof event === "string") return [];
  return planEventRuns(event, deps, appSlug, delivery);
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
      const recorded = await deps.recordRuns(mine.map((c) => recordOf(c, event, `schedule:${slot.dueAt}`)));
      pending.push(...pendingOf(mine, recorded, event));
      const next = nextRun(slot.schedule, Math.max(now.getTime(), Date.parse(slot.dueAt)));
      await deps.advanceSchedule(slot.scheduleId, slot.dueAt, next === null ? null : new Date(next).toISOString());
    } catch (error) {
      // Left due: the next tick tries it again, and records nothing twice.
      console.error(`Schedule ${slot.scheduleId}: couldn't record its runs`, error);
    }
  }
  return pending;
}

export type QueuedDeps = {
  /** Take the waiting runs whose window has passed (claimQueuedRuns). */
  claimQueuedRuns(now: Date): Promise<ClaimedRun[]>;
  /** Their automations as candidates, on or off: what was recorded runs. */
  claimedCandidates(runs: readonly { automationId: string; projectId: string }[]): Promise<RunCandidate[]>;
  settleRun: StartDeps["settleRun"];
};

/**
 * The cron's tick, for runs that waited out a debounce window: those whose
 * window has passed, taken to start. The server that recorded one starts it
 * itself as its window ends (startRun); this is for one a restart cut off,
 * and windows past the time that server waits. Either takes it once. One
 * whose automation no longer runs on its repository, or whose event can't
 * be read, doesn't start, saying why.
 */
export async function planQueuedRuns(now: Date, deps: QueuedDeps, appSlug?: string): Promise<PendingRun[]> {
  const claimed = await deps.claimQueuedRuns(now);
  if (claimed.length === 0) return [];
  const candidates = await deps.claimedCandidates(claimed);
  const pending: PendingRun[] = [];
  for (const run of claimed) {
    const candidate = candidates.find((c) => c.automationId === run.automationId && c.projectId === run.projectId);
    if (!candidate || !run.event) {
      await deps
        .settleRun(run.runId, { status: "refused", reason: "The automation doesn't run on this repository any more." })
        .catch((error: unknown) => console.error(`Run ${run.runId} couldn't be kept`, error));
      continue;
    }
    pending.push({ runId: run.runId, candidate, event: run.event, appSlug, combined: run.combined });
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
  /** Wait until a queued run's window has passed (a later trigger moves it
   *  on), and take it to start: the event it ends with, the last combined
   *  in. Null when another took it (the tick, a later trigger's wait), or
   *  it's no longer waiting. */
  waitOutWindow(runId: string): Promise<{ event: RunEvent; combined: number } | null>;
  /** The automation's last session on the repository, that can be woken
   *  (reusableSession); null when there's none. */
  reusableSession(run: { runId: string; automationId: string; projectId: string }): Promise<string | null>;
  /** Give one of `userId`'s sessions a prompt, waking or restoring it first;
   *  false when it can't be (gone, not answering). */
  continueSession(userId: string, workspaceId: string, prompt: string): Promise<boolean>;
};

/** What a session that ran the automation before is told first: its tree
 *  is where the last run left it. */
function continuing(event: RunEvent): string {
  const where = isPullRequestEvent(event)
    ? `check out the pull request with \`gh pr checkout ${event.number}\``
    : "check out the repository's default branch and pull it";
  return `This session ran this automation before, and this is its next run. Its working tree is where the last run left it: first, ${where}.`;
}

/** Start a run's session and keep how it went. Never throws: the run's
 *  record is all that hears of it. */
export async function startRun(run: PendingRun, deps: StartDeps): Promise<void> {
  const { candidate } = run;
  let { event } = run;
  let combined = run.combined ?? 1;
  const settle = (outcome: Parameters<StartDeps["settleRun"]>[1]) =>
    deps.settleRun(run.runId, outcome).catch((error: unknown) => console.error(`Run ${run.runId} couldn't be kept`, error));
  // In a debounce window: it starts once the window passes with no other
  // trigger, as the last of those it took in. A trigger combined into it
  // waits too; whichever wait (or the tick) takes it first starts it.
  if (run.queued) {
    let claimed: Awaited<ReturnType<StartDeps["waitOutWindow"]>>;
    try {
      claimed = await deps.waitOutWindow(run.runId);
    } catch (error) {
      // Left waiting: the tick takes it.
      console.error(`Run ${run.runId}: couldn't wait out its window`, error);
      return;
    }
    if (!claimed) return;
    ({ event, combined } = claimed);
  }
  // A review of a pull request's code has its check on the pull request
  // from the start (lib/automations/checks.ts): in progress until its
  // review is posted, or it can't be. Any other run (closed, merged, an
  // issue, a schedule, a webhook) has none.
  const reviewed = isPullRequestEvent(event) && atHead(event.trigger) ? event : null;
  const checked = reviewed !== null;
  if (reviewed) await deps.openCheck({ ...run, event: reviewed });
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
  const prompt = [
    combined > 1 ? `${combined} triggers came within this automation's debounce window; this run is for the last of them.` : "",
    // Told its id, to mark its review with, when the review closes a check.
    eventPrompt(candidate.prompt, event, {
      repoFullName: candidate.repoFullName,
      appSlug: run.appSlug,
      runId: checked ? run.runId : undefined,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  // Reusing its session: the automation's last one on the repository is
  // given this run's prompt, woken or restored first. One that can't be is
  // left, and a new one made, which the next run reuses.
  if (candidate.sessionMode === "reuse") {
    try {
      const session = await deps.reusableSession({
        runId: run.runId,
        automationId: candidate.automationId,
        projectId: candidate.projectId,
      });
      if (session && (await deps.continueSession(runner, session, `${continuing(event)}\n\n${prompt}`))) {
        await settle({ status: "ready", workspaceId: session, reason: null });
        return;
      }
    } catch (error) {
      console.error(`Run ${run.runId}: couldn't reuse the automation's session`, error);
    }
  }
  const result = await deps.startServerSession({
    userId: runner,
    projectId: candidate.projectId,
    baseBranch: eventBaseBranch(event),
    title: eventTitle(candidate.name, event),
    prompt,
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
  // ready; one that failed leaves this one open.) Only a review of the
  // pull request's code, opened or given new commits, takes over; any other
  // run stands on its own, as does a reused session.
  if (
    isPullRequestEvent(event) &&
    (event.trigger === "pull_request.opened" || event.trigger === "pull_request.synchronize") &&
    candidate.sessionMode === "new" &&
    result.status === "ready" &&
    result.workspaceId
  ) {
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
  // One that has run its count is off, but a run of it that failed still
  // runs again: it's one of its count.
  if (!target.enabled && !target.limited) {
    return { ok: false, status: 409, error: "The automation is off: turn it on to run it." };
  }
  if (!target.covered) {
    return { ok: false, status: 409, error: "The automation doesn't run on this repository any more." };
  }
  // Every run works on GitHub as the App: without it live on the
  // repository's account, its session couldn't get a token.
  if (target.installationSuspended) {
    return { ok: false, status: 409, error: SUSPENDED };
  }
  if (target.installationId === null) {
    return { ok: false, status: 409, error: "The GitHub App isn't installed on this repository's account." };
  }
  // Anything but a review of a pull request's head starts over as it first
  // would have: the same run, told the same event (a schedule's time, a
  // webhook's payload, an issue, a pull request merged).
  if (target.trigger !== null && target.trigger !== "pull_request.opened" && target.trigger !== "pull_request.synchronize") {
    if (!target.event) return { ok: false, status: 409, error: "This run can't be started again." };
    if (!(await deps.reopenRun(target.runId))) return { ok: false, status: 409, error: "It's running again already." };
    return { ok: true, run: { runId: target.runId, candidate: target.candidate, event: target.event, appSlug }, staleSession: target.workspaceId };
  }
  if (target.prNumber === null) return { ok: false, status: 409, error: "This run can't be started again." };
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
  const recorded = await deps.recordRuns([recordOf(target.candidate, event, eventDedupeKey(event, null))]);
  const newId = recorded.get(`${target.candidate.automationId}:${target.candidate.projectId}`)?.runId;
  if (!newId) {
    return { ok: false, status: 409, error: "The pull request has newer commits, with their own run: run that one again instead." };
  }
  // The failed run keeps its session, if it made one: the new run archives
  // it as an earlier one once it's ready (runNeighbours).
  return { ok: true, run: { runId: newId, candidate: target.candidate, event, appSlug }, staleSession: null };
}
