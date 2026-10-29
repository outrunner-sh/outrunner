/**
 * Whether a Runner's pull request has settled, and how (docs/missions.md):
 * once its CI and review activity has been quiet a while, ready (it waits on
 * nothing but a person's review or branch protection) or needing attention
 * (something only the Mission or the user can unblock). Decided from what
 * GitHub says of it now, never from what activity alone suggests. The parts
 * with no network; lib/missions/pull-requests.ts reads GitHub and acts.
 */

/** Quiet this long, a pull request's activity has settled. */
export const SETTLE_MS = 3 * 60_000;
/** Still unsettled this long after its activity began, it needs attention. */
export const GIVE_UP_MS = 60 * 60_000;

export type PullRequestFacts = {
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** GitHub's mergeable_state: clean, unstable, blocked, behind, dirty,
   *  draft, has_hooks, unknown. */
  mergeableState: string;
  headSha: string;
  checks: { passing: number; failing: number; pending: number };
  /** A reviewer's latest review asks for changes. */
  changesRequested: boolean;
  /** Approved by a reviewer, with none asking for changes. */
  approved: boolean;
  /** The pull request it's stacked on (its base is another's head), if any. */
  stackedOn?: number | null;
};

export type SettleInput = {
  now: number;
  firstActivityAt: number;
  lastActivityAt: number;
  /** A fix is running for it: its Runner is mid-turn (GitHub's CI-failure
   *  and review follow-ups run in the Runner's own session). */
  fixRunning: boolean;
  facts: PullRequestFacts;
};

export type SettleDecision =
  | { kind: "merged" }
  | { kind: "closed" }
  | { kind: "wait"; why: string }
  | { kind: "ready"; reason: string }
  | { kind: "needs_attention"; reason: string };

export function settle(input: SettleInput): SettleDecision {
  const { facts, now } = input;
  if (facts.state === "merged") return { kind: "merged" };
  if (facts.state === "closed") return { kind: "closed" };

  const waited = now - input.firstActivityAt;
  // Waiting on something that should end: past the hour, it hasn't.
  const wait = (why: string): SettleDecision =>
    waited >= GIVE_UP_MS ? { kind: "needs_attention", reason: `it hasn't settled within an hour (${why})` } : { kind: "wait", why };

  if (now - input.lastActivityAt < SETTLE_MS) return wait("activity in the last few minutes");
  if (input.fixRunning) return wait("a fix is running in its Runner");
  if (facts.checks.pending > 0) return wait("checks are still running");
  // GitHub works mergeability out after a push; until it has, nothing's known.
  if (facts.mergeableState === "unknown" || facts.mergeableState === "") return wait("GitHub is still working out whether it merges");

  if (facts.draft || facts.mergeableState === "draft") return { kind: "needs_attention", reason: "it's still a draft" };
  if (facts.mergeableState === "dirty") return { kind: "needs_attention", reason: "it has merge conflicts" };
  if (facts.changesRequested) return { kind: "needs_attention", reason: "a reviewer asked for changes" };
  if (facts.checks.failing > 0) {
    return { kind: "needs_attention", reason: `${facts.checks.failing} check${facts.checks.failing === 1 ? "" : "s"} failing, with no fix running` };
  }

  // Green from here: what's left is a person's, or branch protection's.
  const stacked = facts.stackedOn ? ` (stacked on #${facts.stackedOn}, which merges first)` : "";
  switch (facts.mergeableState) {
    case "behind":
      return { kind: "ready", reason: `checks pass; it's behind its base branch, which branch protection may want updated${stacked}` };
    case "blocked":
      return {
        kind: "ready",
        reason: `checks pass; ${facts.approved ? "approved, and " : ""}waiting on ${facts.approved ? "branch protection" : "a review"}${stacked}`,
      };
    default:
      return { kind: "ready", reason: `checks pass and it merges cleanly${facts.approved ? ", approved" : ", waiting on a review"}${stacked}` };
  }
}

/**
 * Whether a decision is news to the Mission: one that differs from the last
 * reported, or the same on new commits. A webhook delivered twice, or a tick
 * deciding again on nothing new, reports nothing.
 */
export function isNews(
  decided: { verdict: "ready" | "needs_attention"; sha: string },
  reported: { verdict: string | null; sha: string | null },
): boolean {
  return decided.verdict !== reported.verdict || decided.sha !== reported.sha;
}

/** A branch of the Runner's: its own, or one named after it for a stacked
 *  pull request (`<branch>-2`). */
export function isRunnerBranch(runnerBranch: string, headRef: string): boolean {
  return headRef === runnerBranch || (headRef.startsWith(`${runnerBranch}-`) && headRef.length > runnerBranch.length + 1);
}

/** Whether every one of a Runner's pull requests is done with, so the Runner
 *  is too: at least one, and none still open. */
export function allPullRequestsDone(states: readonly ("open" | "merged" | "closed")[]): boolean {
  return states.length > 0 && states.every((s) => s !== "open");
}

type Review = { state?: string; user?: { id?: number; login?: string } | null; submitted_at?: string | null };

/** What a pull request's reviews come to: each reviewer's latest review that
 *  decided something (a comment alone doesn't, and a dismissed one is
 *  withdrawn). */
export function reviewState(reviews: readonly Review[]): { changesRequested: boolean; approved: boolean } {
  const latest = new Map<string, string>();
  const ordered = [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
  for (const review of ordered) {
    const who = String(review.user?.id ?? review.user?.login ?? "");
    if (!who || !review.state) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") latest.set(who, review.state);
  }
  const states = [...latest.values()];
  const changesRequested = states.includes("CHANGES_REQUESTED");
  return { changesRequested, approved: !changesRequested && states.includes("APPROVED") };
}
