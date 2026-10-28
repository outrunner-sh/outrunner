import type { PullRequestStatus, WorkspacePullRequestRef } from "@/lib/github/client";

/** What the PR row says of a pull request, and whether it offers Merge:
 *  `why` says in a sentence why not, null when it does. */
export type PullRequestVerdict = {
  label: string;
  tone: "ready" | "pending" | "problem" | "done";
  canMerge: boolean;
  why: string | null;
};

/**
 * A pull request's status in a few words, as Conductor's bar puts it. Merge is
 * offered only for a green one: open, not a draft, every check passed (or none
 * ran) and GitHub calling it mergeable as is (`clean`, or `has_hooks`, which
 * is clean with pre-receive hooks).
 */
export function pullRequestVerdict(status: PullRequestStatus): PullRequestVerdict {
  const verdict = (label: string, tone: PullRequestVerdict["tone"], why: string) => ({ label, tone, canMerge: false, why });
  if (status.state === "merged") return verdict("Merged", "done", "This PR is merged.");
  if (status.state === "closed") return verdict("Closed", "done", "This PR is closed.");
  if (status.draft) return verdict("Draft", "pending", "It's a draft.");
  if (status.checks.failing > 0) return verdict("Checks failing", "problem", "Checks are failing.");
  if (status.mergeableState === "dirty") {
    return verdict("Merge conflicts", "problem", "It has merge conflicts with its base branch.");
  }
  if (status.checks.pending > 0) return verdict("Checks running", "pending", "Checks are still running.");
  switch (status.mergeableState) {
    case "clean":
    case "has_hooks":
      return { label: "Ready to merge", tone: "ready", canMerge: true, why: null };
    case "unstable":
      // A failing commit status or check GitHub counts, though not one the
      // checks summary saw fail.
      return verdict("Checks failing", "problem", "GitHub reports a failing check or commit status.");
    case "behind":
      return verdict("Behind base branch", "problem", "It's behind its base branch.");
    case "blocked":
      return verdict("Blocked", "problem", "GitHub won't merge it yet: a required review or check is missing.");
    default:
      // GitHub works mergeability out lazily: "unknown" until it has.
      return verdict("Checking…", "pending", "GitHub is still working out whether it can be merged.");
  }
}

/**
 * Why a pull request isn't offered Merge, in a sentence, or null when it is:
 * by the same verdict as the session's PR row, so the Review tab doesn't
 * offer Merge for a PR GitHub calls conflicting, behind or blocked, or hasn't
 * worked out yet, only for GitHub to refuse it.
 */
export function whyNotMergeable(status: PullRequestStatus): string | null {
  return pullRequestVerdict(status).why;
}

/**
 * The pull request that took over from the session's recorded one, if one
 * did: the recorded PR closed unmerged and a newer one opened from the same
 * branch (one that aimed at the wrong base, say, opened again). Otherwise the
 * session would show the closed one for good, its row settled on "Closed",
 * and the new one never shown or merged from the session. Null to keep the
 * recorded one; a merged PR is never replaced.
 */
export function supersedingPullRequest(
  recorded: { number: number },
  status: PullRequestStatus | null,
  newest: WorkspacePullRequestRef | null,
): WorkspacePullRequestRef | null {
  if (status?.state !== "closed" || !newest) return null;
  return newest.number > recorded.number ? newest : null;
}
