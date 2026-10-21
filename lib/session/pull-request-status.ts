import type { PullRequestStatus } from "@/lib/github/client";

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
