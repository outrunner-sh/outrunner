/**
 * What the Review tab offers for merging a pull request, and what the merge
 * route will do when asked: merge by the repository's rules, add it to the
 * base branch's merge queue when the branch has one, or, for someone GitHub
 * lets past the rules, "Bypass rules and merge".
 *
 * A plain Merge is only ever offered, and only ever done, for a PR that
 * passes the rules: an admin's token would merge a blocked PR just the same,
 * and nobody should bypass the rules without asking to.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

import type { MergeAccess, PullRequestStatus } from "@/lib/github/client";
import { whyNotMergeable } from "@/lib/session/pull-request-status";

export type MergeAction = "merge" | "queue" | "bypass";

export type MergeOffer = {
  /** The usual way: merge, or add to the merge queue. */
  primary: { action: "merge" | "queue"; label: string; why: string | null } | { action: "queued"; position: number | null };
  /** Whether "Bypass rules and merge" shows. */
  bypass: boolean;
};

/** Why the merge queue won't take it, or null when it may. The queue runs
 *  the required checks itself, so only what it can't fix holds it back. */
export function whyNotQueueable(status: PullRequestStatus): string | null {
  if (status.state !== "open") return status.state === "merged" ? "This PR is merged." : "This PR is closed.";
  if (status.draft) return "It's a draft.";
  if (status.mergeableState === "dirty") return "It has merge conflicts with its base branch.";
  if (status.checks.failing > 0) return "Checks are failing.";
  return null;
}

/** Why it can't be merged past the rules either: what no bypass skips. */
function whyNotBypassable(status: PullRequestStatus): string | null {
  if (status.state !== "open") return "It isn't open.";
  if (status.draft) return "It's a draft.";
  if (status.mergeableState === "dirty") return "It has merge conflicts with its base branch.";
  return null;
}

/**
 * The offer for one PR as one person sees it. `access` is null when their
 * GitHub account couldn't be asked (not connected, or GitHub didn't answer):
 * then it's a plain Merge by the rules, as before.
 */
export function mergeOffer(status: PullRequestStatus, access: MergeAccess | null): MergeOffer {
  const primary: MergeOffer["primary"] =
    access?.queuePosition !== null && access?.queuePosition !== undefined
      ? { action: "queued", position: access.queuePosition || null }
      : access?.mergeQueue
        ? { action: "queue", label: "Merge when ready", why: whyNotQueueable(status) }
        : { action: "merge", label: "Merge", why: whyNotMergeable(status) };
  // Bypassing is worth offering only where the usual way won't merge it now:
  // the rules hold it back, or a queue would make it wait its turn.
  const heldBack = primary.action !== "merge" || primary.why !== null;
  return { primary, bypass: !!access?.canBypass && heldBack && whyNotBypassable(status) === null };
}

/**
 * Whether the route may do `action` for this PR now, re-read as it's asked:
 * null when it may, else why not. GitHub has the last word on each.
 */
export function refuseMerge(action: MergeAction, status: PullRequestStatus, access: MergeAccess | null): string | null {
  const offer = mergeOffer(status, access);
  if (action === "bypass") {
    if (!access?.canBypass) return "Your GitHub account can't bypass this branch's rules.";
    return whyNotBypassable(status) ?? (offer.bypass ? null : "It can be merged without bypassing the rules.");
  }
  if (offer.primary.action === "queued") return "It's already in the merge queue.";
  if (action !== offer.primary.action) {
    return action === "merge" ? "Its base branch merges through a merge queue." : "Its base branch has no merge queue.";
  }
  return offer.primary.why;
}
