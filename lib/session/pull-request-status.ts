import type { PullRequestStatus, WorkspacePullRequestRef } from "@/lib/github/client";

/** What the PR row says of a pull request, and whether it offers Merge. */
export type PullRequestVerdict = {
  label: string;
  tone: "ready" | "pending" | "problem" | "done";
  canMerge: boolean;
};

/**
 * A pull request's status in a few words, as Conductor's bar puts it. Merge is
 * offered only for a green one: open, not a draft, every check passed (or none
 * ran) and GitHub calling it mergeable as is (`clean`, or `has_hooks`, which
 * is clean with pre-receive hooks).
 */
export function pullRequestVerdict(status: PullRequestStatus): PullRequestVerdict {
  const verdict = (label: string, tone: PullRequestVerdict["tone"], canMerge = false) => ({ label, tone, canMerge });
  if (status.state === "merged") return verdict("Merged", "done");
  if (status.state === "closed") return verdict("Closed", "done");
  if (status.draft) return verdict("Draft", "pending");
  if (status.checks.failing > 0) return verdict("Checks failing", "problem");
  if (status.mergeableState === "dirty") return verdict("Merge conflicts", "problem");
  if (status.checks.pending > 0) return verdict("Checks running", "pending");
  switch (status.mergeableState) {
    case "clean":
    case "has_hooks":
      return verdict("Ready to merge", "ready", true);
    case "unstable":
      return verdict("Checks failing", "problem");
    case "behind":
      return verdict("Behind base branch", "problem");
    case "blocked":
      return verdict("Blocked", "problem");
    default:
      // GitHub works mergeability out lazily: "unknown" until it has.
      return verdict("Checking…", "pending");
  }
}

/** Why Merge isn't offered, by the verdict's label, as a sentence. */
const WHY_NOT: Record<string, string> = {
  Merged: "This PR is merged.",
  Closed: "This PR is closed.",
  Draft: "It's a draft.",
  "Checks failing": "Checks are failing.",
  "Merge conflicts": "It has merge conflicts with its base branch.",
  "Checks running": "Checks are still running.",
  "Behind base branch": "It's behind its base branch.",
  Blocked: "GitHub won't merge it yet: a required review or check is missing.",
};

/**
 * Why a pull request isn't offered Merge, in a sentence, or null when it is:
 * by the same verdict as the session's PR row, so the Review tab doesn't
 * offer Merge for a PR GitHub calls conflicting, behind or blocked, or hasn't
 * worked out yet, only for GitHub to refuse it.
 */
export function whyNotMergeable(status: PullRequestStatus): string | null {
  const verdict = pullRequestVerdict(status);
  if (verdict.canMerge) return null;
  return WHY_NOT[verdict.label] ?? "GitHub is still working out whether it can be merged.";
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
