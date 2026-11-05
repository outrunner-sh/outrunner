/**
 * What GitHub says of a session's pull request, read from its webhook payload
 * and its REST record (lib/session/pull-request-state.ts records it). Pure, so
 * it is unit-tested in Node.
 */

export type PullRequestState = "open" | "closed" | "merged";

/** A pull request event's state: what GitHub says of it after the event. */
export function stateOf(pr: { state?: string; merged?: boolean | null; merged_at?: string | null }): PullRequestState | null {
  if (pr.merged === true || (pr.merged_at ?? null) !== null) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.state === "open") return "open";
  return null;
}

export type PullRequestEvent = {
  /** GitHub's own id of the repository: what projects match by. */
  repoId?: number;
  repoFullName: string;
  number: number;
  url: string;
  title: string;
  headRef: string;
  baseRef: string;
  state: PullRequestState;
};

/** The webhook's pull_request payload as a change to record; null for an
 *  action that changes no state (a label, a review request) or a payload
 *  short of what's needed. */
export function pullRequestEventOf(payload: {
  action?: string;
  repository?: { full_name?: string; id?: number };
  pull_request?: {
    number?: number;
    html_url?: string;
    title?: string;
    state?: string;
    merged?: boolean | null;
    merged_at?: string | null;
    head?: { ref?: string };
    base?: { ref?: string };
  };
}): PullRequestEvent | null {
  if (!["opened", "reopened", "closed", "ready_for_review"].includes(payload.action ?? "")) return null;
  const pr = payload.pull_request;
  const state = pr ? stateOf(pr) : null;
  const repoFullName = payload.repository?.full_name;
  if (!pr || !state || !repoFullName || typeof pr.number !== "number" || !pr.html_url || !pr.head?.ref) return null;
  return {
    ...(typeof payload.repository?.id === "number" && { repoId: payload.repository.id }),
    repoFullName,
    number: pr.number,
    url: pr.html_url,
    title: pr.title ?? "",
    headRef: pr.head.ref,
    baseRef: pr.base?.ref ?? "",
    state,
  };
}
