import { githubGet } from "@/lib/github/rest";
import { type LineQuote, type ReviewThread, toReviewThreads } from "@/lib/review/change";

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          path
          diffSide
          line
          startLine
          first: comments(first: 1) { nodes { databaseId author { login } body url } }
          latest: comments(last: 3) { nodes { databaseId author { login } body url } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** A PR's selected-line review threads, filtered to authors with repository
 *  write access. Unknown permission fails closed; empty when GitHub won't say. */
export async function readReviewThreads(token: string, repo: string, number: number, quote: LineQuote | null): Promise<ReviewThread[]> {
  if (!quote) return [];
  const [owner, name] = repo.split("/");
  try {
    const nodes: unknown[] = [];
    let cursor: string | null = null;
    while (true) {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: REVIEW_THREADS_QUERY, variables: { owner, name, number, cursor } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } };
        errors?: unknown[];
      } | null;
      const connection = body?.data?.repository?.pullRequest?.reviewThreads;
      if (!response.ok || body?.errors?.length || !connection?.nodes || !connection.pageInfo) return [];
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) break;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) return [];
      cursor = connection.pageInfo.endCursor;
    }

    // Restrict both permission lookups and prompt context to unresolved threads
    // that intersect the exact selected file, diff side, and line range.
    const selected = toReviewThreads(nodes).filter((thread) => {
      const root = thread.comments[0];
      return (
        !thread.resolved &&
        !!root &&
        thread.path === quote.path &&
        thread.side === quote.side &&
        thread.startLine <= quote.endLine &&
        thread.endLine >= quote.startLine
      );
    });
    const authors = [...new Set(selected.flatMap((thread) => thread.comments.flatMap((comment) => (comment.author ? [comment.author] : []))))];
    const permissions = await Promise.all(
      authors.map(async (login) => {
        const permission = await githubGet<{ permission?: string }>(
          token,
          `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        );
        return [login, permission?.permission === "admin" || permission?.permission === "write"] as const;
      }),
    );
    const writable = new Set(permissions.filter(([, canWrite]) => canWrite).map(([login]) => login));
    return selected.flatMap((thread) => {
      const [root, ...replies] = thread.comments;
      if (!root?.author || !writable.has(root.author)) return [];
      return [
        {
          ...thread,
          comments: [root, ...replies.filter((reply) => reply.author && writable.has(reply.author))].map((comment) => ({
            ...comment,
            writeAccess: true,
          })),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** A commit pushed to a PR since some other one. */
export type PushedCommit = { sha: string; message: string; url: string };

/** The commits on a PR's head since `since`, oldest first (at most 20);
 *  empty when there are none, the base diverged, or GitHub can't compare them. */
export async function commitsSince(token: string, repo: string, since: string, head: string): Promise<PushedCommit[]> {
  if (since === head) return [];
  const compare = await githubGet<{ status?: string; commits?: { sha?: string; html_url?: string; commit?: { message?: string } }[] }>(
    token,
    `/repos/${repo}/compare/${encodeURIComponent(since)}...${encodeURIComponent(head)}`,
  );
  // Diverged bases are a force-push/rewrite, not commits made for this request.
  if (compare?.status !== "ahead") return [];
  return (compare?.commits ?? []).slice(-20).flatMap((c) =>
    typeof c.sha === "string" ? [{ sha: c.sha, message: (c.commit?.message ?? "").split("\n")[0], url: c.html_url ?? "" }] : [],
  );
}
