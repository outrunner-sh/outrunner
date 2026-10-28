/**
 * What the Outrunner GitHub App says and reads in an issue's or pull
 * request's conversation, as the installation: replies to a mention, the 👀
 * on it, and the pull request a comment is on. Each takes its token and its
 * fetch, for the tests.
 */

const API = "https://api.github.com";

type Fetch = typeof fetch;

/** GitHub refused or failed one of these calls; never carries a token. */
export class GitHubConversationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubConversationError";
    this.status = status;
  }
}

async function call<T>(doFetch: Fetch, path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await doFetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "outrunner",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new GitHubConversationError(`GitHub answered ${response.status} to ${init.method ?? "GET"} ${path.split("?")[0]}`, response.status);
  }
  return (await response.json()) as T;
}

/** A comment as a mention names it: on the conversation, or on a line. */
export type CommentRef = { id: number; kind: "issue_comment" | "review_comment" };

/** React to a comment (`eyes`: picked up). One already there is GitHub's
 *  200, not an error. */
export async function reactToComment(
  token: string,
  repoFullName: string,
  comment: CommentRef,
  content: "eyes" | "rocket" | "confused",
  doFetch: Fetch = fetch,
): Promise<void> {
  const path =
    comment.kind === "review_comment"
      ? `/repos/${repoFullName}/pulls/comments/${comment.id}/reactions`
      : `/repos/${repoFullName}/issues/comments/${comment.id}/reactions`;
  await call(doFetch, path, token, { method: "POST", body: { content } });
}

/** Reply to a comment where it was made: in a line's thread for a review
 *  comment, else on the issue's or pull request's conversation. */
export async function replyToComment(
  token: string,
  repoFullName: string,
  number: number,
  comment: CommentRef,
  body: string,
  doFetch: Fetch = fetch,
): Promise<void> {
  if (comment.kind === "review_comment") {
    await call(doFetch, `/repos/${repoFullName}/pulls/${number}/comments/${comment.id}/replies`, token, {
      method: "POST",
      body: { body },
    });
    return;
  }
  await postIssueComment(token, repoFullName, number, body, doFetch);
}

/** A comment on an issue's or pull request's conversation. */
export async function postIssueComment(
  token: string,
  repoFullName: string,
  number: number,
  body: string,
  doFetch: Fetch = fetch,
): Promise<void> {
  await call(doFetch, `/repos/${repoFullName}/issues/${number}/comments`, token, { method: "POST", body: { body } });
}

/** A pull request as GitHub's API gives it. */
export async function readPull(
  token: string,
  repoFullName: string,
  number: number,
  doFetch: Fetch = fetch,
): Promise<Record<string, unknown>> {
  return call(doFetch, `/repos/${repoFullName}/pulls/${number}`, token);
}

/** A review as GitHub's API gives it. */
export type ApiReview = {
  id: number;
  state?: string;
  body?: string | null;
  html_url?: string;
  user?: { id?: number; login?: string; type?: string } | null;
};

/** A review comment as GitHub's API gives it. */
export type ApiReviewComment = {
  id: number;
  body?: string;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  side?: string | null;
  diff_hunk?: string | null;
  user?: { id?: number; login?: string; type?: string } | null;
};

/** A submitted review of a pull request, and its comments on lines. */
export async function readReview(
  token: string,
  repoFullName: string,
  number: number,
  reviewId: number,
  doFetch: Fetch = fetch,
): Promise<{ review: ApiReview; comments: ApiReviewComment[] }> {
  const base = `/repos/${repoFullName}/pulls/${number}/reviews/${reviewId}`;
  const [review, comments] = await Promise.all([
    call<ApiReview>(doFetch, base, token),
    call<ApiReviewComment[]>(doFetch, `${base}/comments?per_page=100`, token),
  ]);
  return { review, comments };
}
