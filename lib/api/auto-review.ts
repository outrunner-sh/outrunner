/**
 * The review a session started through the API with `auto_create_pr` is
 * asked for once it opens its pull request (lib/api/webhooks.deps.ts): the
 * app's Review button's own request, "Review my changes" with
 * `Review request.md` attached (lib/session/review-instructions.ts), so an
 * API caller's PR is reviewed the way a PR opened in the app is.
 */

import type { SessionCheckout } from "@/lib/runtime/types";
import { REVIEW_INSTRUCTIONS_FILENAME, REVIEW_PROMPT, reviewInstructions } from "@/lib/session/review-instructions";

/** A pull request the session opened, as its turn's end found it. */
export type OpenedPullRequest = { projectId: string; number: number; baseBranch: string };

export type ReviewRequest = { prompt: string; files: { filename: string; content: string }[] };

/** The request for the pull requests a turn opened, null for none. A session
 *  of several repositories gets one file per pull request, each its own
 *  repository's review. */
export function autoReviewRequest(checkouts: readonly SessionCheckout[] | null, prs: readonly OpenedPullRequest[]): ReviewRequest | null {
  if (prs.length === 0) return null;
  const files = prs.map((pr) => {
    const checkout = checkouts?.find((c) => c.projectId === pr.projectId);
    const repo = checkout && { checkout: checkout.checkout, fullName: checkout.fullName };
    return {
      filename: prs.length === 1 ? REVIEW_INSTRUCTIONS_FILENAME : `Review request (${repo?.checkout ?? `#${pr.number}`}).md`,
      content: reviewInstructions({ baseBranch: pr.baseBranch, pullRequestNumber: pr.number, ...(repo && { repo }) }),
    };
  });
  return { prompt: REVIEW_PROMPT, files };
}
