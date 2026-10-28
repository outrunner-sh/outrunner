/**
 * A run's check on its pull request: the GitHub App's check run on the head
 * commit, in progress while the review runs, closed when it's posted (the
 * App's comment carrying the run's marker), or when it can't be: the run
 * fails, the pull request closes, or no review comes within the hour. A
 * review scoring 4/5 or more passes; anything else is neutral, never a
 * failure, so it informs a merge and never blocks one.
 */

import type { CheckOutput } from "@/lib/github/app";

/** How long a review may take before its check is closed without one. */
export const CHECK_HOURS = 1;

/** The line a run's session ends its summary comment with: hidden on GitHub,
 *  and how the comment's webhook finds the run (several automations post as
 *  the same App). */
export function runMarker(runId: string): string {
  return `<!-- outrunner-run:${runId} -->`;
}

const MARKER = /<!--\s*outrunner-run:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-->/i;

/** The run a comment is the review of, or null. */
export function readRunMarker(body: string): string | null {
  return MARKER.exec(body)?.[1]?.toLowerCase() ?? null;
}

/** What the check says while the review runs. */
export const IN_PROGRESS: CheckOutput = {
  title: "Reviewing",
  summary: "Outrunner is reviewing this commit. Its review is posted as a comment on the pull request.",
};

/** A review's score out of 5 ("Score: 4/5", "**Score: 4.5/5**"), or null. */
export function reviewScore(body: string): number | null {
  // The last one: a summary may mention an earlier pass's score first.
  const match = [...body.matchAll(/score\W{0,6}(\d(?:\.\d)?)\s*\/\s*5\b/gi)].at(-1);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= 0 && score <= 5 ? score : null;
}

/** How a posted review closes its check: passing at 4/5 or more. */
export function reviewOutcome(body: string, commentUrl: string): { conclusion: "success" | "neutral"; output: CheckOutput } {
  const score = reviewScore(body);
  return {
    conclusion: score !== null && score >= 4 ? "success" : "neutral",
    output: {
      title: score === null ? "Review posted" : `Score: ${score}/5`,
      summary: `The review is [on the pull request](${commentUrl}).`,
    },
  };
}

/** How a check closes without a review: neutral, saying why. */
export function closedWithout(reason: string): { conclusion: "neutral"; output: CheckOutput } {
  return { conclusion: "neutral", output: { title: "No review", summary: reason } };
}

export type CheckOutcome = ReturnType<typeof reviewOutcome> | ReturnType<typeof closedWithout>;

export type CommentDeps = {
  openCheckOf(runId: string): Promise<{ installationId: number; repoFullName: string; prNumber: number } | null>;
  closeCheck(runId: string, outcome: CheckOutcome): Promise<void>;
};

type Posted = { body?: unknown; html_url?: unknown; user?: { login?: unknown } | null } | null;

type CommentPayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  /** issue_comment: a comment on a pull request's conversation. */
  issue?: { number?: unknown; pull_request?: unknown } | null;
  comment?: Posted;
  /** pull_request_review: a review's body, should the summary be one. */
  pull_request?: { number?: unknown } | null;
  review?: Posted;
};

/**
 * A comment posted on a pull request's conversation (`issue_comment`), or a
 * review submitted on it (`pull_request_review`): when it's the App's own and
 * carries a run's marker, that run's review is in, and its check closes with
 * it. Only the App's comments count (anyone can write a marker), and only on
 * the pull request the run's check is on, through the same installation.
 * Whether one closed.
 */
export async function finishCheckFromComment(payload: unknown, appSlug: string, deps: CommentDeps): Promise<boolean> {
  const p = (payload ?? {}) as CommentPayload;
  const posted =
    p.action === "created" && p.issue?.pull_request
      ? { item: p.comment, number: p.issue.number }
      : p.action === "submitted" && p.pull_request
        ? { item: p.review, number: p.pull_request.number }
        : null;
  if (!posted) return false;
  const login = posted.item?.user?.login;
  if (typeof login !== "string" || login.toLowerCase() !== `${appSlug.toLowerCase()}[bot]`) return false;
  const body = posted.item?.body;
  const url = posted.item?.html_url;
  if (typeof body !== "string" || typeof url !== "string") return false;
  const runId = readRunMarker(body);
  if (!runId) return false;
  const check = await deps.openCheckOf(runId);
  if (
    !check ||
    check.installationId !== p.installation?.id ||
    check.prNumber !== posted.number ||
    typeof p.repository?.full_name !== "string" ||
    check.repoFullName.toLowerCase() !== p.repository.full_name.toLowerCase()
  ) {
    return false;
  }
  await deps.closeCheck(runId, reviewOutcome(body, url));
  return true;
}

/** How a run's check stands, as closing it needs. */
export type CheckStanding<C> = { check: C; closed: boolean; review: CheckOutcome | null };

export type CloseDeps<C> = {
  checkStateOf(runId: string): Promise<CheckStanding<C> | null>;
  /** Take it to close without a review: once, and never once a review is in. */
  claimCheck(runId: string): Promise<boolean>;
  /** Give a claim back, unless a review is in. */
  releaseCheck(runId: string): Promise<void>;
  markCheckReviewed(runId: string, outcome: CheckOutcome): Promise<void>;
  markCheckClosed(runId: string): Promise<void>;
  /** Close it on GitHub; a completed check can be completed again. */
  completeCheck(check: C, outcome: CheckOutcome): Promise<void>;
};

/**
 * Close a run's check without a review, saying why: once, and never once
 * its review is in. A close GitHub didn't take is given back for the sweep.
 * Should the review land while this close is on its way, the review's is
 * sent after it, so the check ends as the review's whichever GitHub took
 * last.
 */
export async function closeCheckWithout<C>(runId: string, reason: string, deps: CloseDeps<C>): Promise<void> {
  const state = await deps.checkStateOf(runId);
  if (!state || state.closed || state.review) return;
  if (!(await deps.claimCheck(runId))) return;
  try {
    await deps.completeCheck(state.check, closedWithout(reason));
  } catch (error) {
    await deps.releaseCheck(runId).catch(() => {});
    throw error;
  }
  const after = await deps.checkStateOf(runId);
  if (after?.review) await sendReview(runId, after.check, after.review, deps);
}

/**
 * Close a run's check with its review, however late (after the hour's
 * sweep closed it without one too). The review's outcome is kept first, so
 * nothing closes the check otherwise from then on, and it's sent until
 * GitHub takes it: should this send fail, the sweep sends it again.
 */
export async function closeCheckWithReview<C>(runId: string, outcome: CheckOutcome, deps: CloseDeps<C>): Promise<void> {
  const state = await deps.checkStateOf(runId);
  if (!state) return;
  await deps.markCheckReviewed(runId, outcome);
  await sendReview(runId, state.check, outcome, deps);
}

async function sendReview<C>(runId: string, check: C, outcome: CheckOutcome, deps: CloseDeps<C>): Promise<void> {
  await deps.completeCheck(check, outcome);
  await deps.markCheckClosed(runId);
}

/** The sweep's second half: send again the reviews GitHub didn't take. */
export async function resendReview<C>(runId: string, deps: CloseDeps<C>): Promise<void> {
  const state = await deps.checkStateOf(runId);
  if (!state?.review || state.closed) return;
  await sendReview(runId, state.check, state.review, deps);
}
