/** A pull request's changed files, read from GitHub. No server imports, so
 *  the tests can run it. */

import { githubGet } from "@/lib/github/rest";
import { type PullFile, toPullFiles } from "@/lib/review/hunks";
import { countLines, type LineCounts } from "@/lib/review/line-kinds";

/** GitHub lists at most this many of a PR's files a page, and the Review
 *  tab reads at most this many pages for a PR's page (GitHub itself stops at
 *  3,000 files). */
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 5;

/** A pull request's changed files, with their patches; `complete` is false
 *  when there are more than were read (past the pages asked for, or a page
 *  GitHub didn't give). Null when not even the first page could be read. */
export async function pullFiles(
  token: string,
  repo: string,
  number: number,
  pages = MAX_FILE_PAGES,
): Promise<{ files: PullFile[]; complete: boolean } | null> {
  const files: PullFile[] = [];
  for (let page = 1; page <= pages; page++) {
    const records = await githubGet<unknown[]>(token, `/repos/${repo}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`);
    if (!records) return page === 1 ? null : { files, complete: false };
    files.push(...toPullFiles(records));
    if (records.length < FILES_PER_PAGE) return { files, complete: true };
  }
  return { files, complete: false };
}

/** A PR's lines by kind, and whether every one of its files was counted. */
export type FileCounts = { lines: LineCounts; complete: boolean };

/**
 * Some open PRs' lines by kind, for the inbox: one GraphQL call for all of
 * them in a repository, reading each file's path and counts but never its
 * patch. Each PR's first 100 files are counted; `complete` says whether
 * there were more (GitHub's `hasNextPage`, so a PR of exactly 100 is
 * complete). A PR GitHub didn't answer for is left out.
 */
export async function inboxFileCounts(token: string, repo: string, numbers: readonly number[]): Promise<Map<number, FileCounts>> {
  const counts = new Map<number, FileCounts>();
  const wanted = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (wanted.length === 0) return counts;
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${wanted.map((n) => `    p${n}: pullRequest(number: ${n}) { files(first: 100) { pageInfo { hasNextPage } nodes { path additions deletions } } }`).join("\n")}
  }
}`;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, name } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return counts;
    type Files = { files?: { pageInfo?: { hasNextPage?: unknown }; nodes?: { path?: unknown; additions?: unknown; deletions?: unknown }[] } | null } | null;
    const body = (await response.json().catch(() => null)) as { data?: { repository?: Record<string, Files> | null } } | null;
    const repository = body?.data?.repository ?? {};
    for (const n of wanted) {
      const files = repository[`p${n}`]?.files;
      if (!files?.nodes) continue;
      counts.set(n, {
        lines: countLines(
          files.nodes.flatMap((f) =>
            typeof f?.path === "string"
              ? [{ path: f.path, additions: typeof f.additions === "number" ? f.additions : 0, deletions: typeof f.deletions === "number" ? f.deletions : 0 }]
              : [],
          ),
        ),
        complete: files.pageInfo?.hasNextPage !== true,
      });
    }
  } catch {
    // The inbox shows these PRs without counts.
  }
  return counts;
}
