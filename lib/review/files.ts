/** A pull request's changed files, read from GitHub. No server imports, so
 *  the tests can run it. */

import { githubGet } from "@/lib/github/rest";
import { type PullFile, toPullFiles } from "@/lib/review/hunks";

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
