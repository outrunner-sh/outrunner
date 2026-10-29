/**
 * Review: the org's open pull requests, and one in full, as the Review tab
 * shows them. Read through the Outrunner GitHub App (each repository's
 * owner's installation), only in repositories the viewer may read, and tied
 * to what Outrunner knows of them: the session that opened one, and its
 * triage item.
 */

import { listOrgProjects } from "@/lib/db/org-access";
import { getPullRequestStatus } from "@/lib/github/client";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { type FileCounts, filesReadComplete, inboxFileCounts, pullFiles } from "@/lib/review/files";
import type { PullFile } from "@/lib/review/hunks";
import { countLines, type LineCounts } from "@/lib/review/line-kinds";
import { githubGetResult } from "@/lib/github/rest";
import { githubGet, repoToken } from "@/lib/slack/github";
import { parseVerdict, type Verdict } from "@/lib/slack/proactive-text";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { TriageActor } from "@/lib/triage/access";

export { commitsSince, readReviewThreads, type PushedCommit } from "@/lib/review/pull-github";

export type Checks = { passing: number; failing: number; pending: number };

export type PullSummary = {
  repo: string;
  projectId: string;
  number: number;
  title: string;
  author: string | null;
  draft: boolean;
  updatedAt: string;
  url: string;
  checks: Checks | null;
  /** Its lines by kind (code, tests, generated); null when unread. Partial
   *  (`linesComplete` false) for a PR of over 100 files. */
  lines: LineCounts | null;
  linesComplete: boolean;
  /** The Outrunner session that opened it, and its triage item. */
  sessionId: string | null;
  itemKey: string | null;
};

type GitHubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  draft?: boolean;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  updated_at: string;
  user?: { login?: string } | null;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  requested_reviewers?: { login?: string }[];
};

/** The org's repositories the viewer may read. */
async function readableRepos(actor: TriageActor): Promise<{ id: string; fullName: string }[]> {
  return (await listOrgProjects(actor.orgId)).filter((p) => actor.levels.has(p.id));
}

// The inbox's line counts, by PR and head commit: a commit's files never
// change, so a PR is read again only once something is pushed to it. Kept
// for this server process, the most recent few hundred.
const countsByHead = new Map<string, FileCounts>();
const COUNTS_KEPT = 500;

/** Some PRs' lines by kind for the inbox, by their place in the list: from
 *  what was kept for their head, else read for each repository at once. */
async function inboxCounts(pulls: readonly { token: string; repo: string; number: number; headSha: string }[]): Promise<(FileCounts | null)[]> {
  const key = (p: (typeof pulls)[number]) => `${p.repo}#${p.number}@${p.headSha}`;
  const unread = new Map<string, (typeof pulls)[number][]>();
  for (const p of pulls) if (!countsByHead.has(key(p))) unread.set(p.repo, [...(unread.get(p.repo) ?? []), p]);
  await Promise.all(
    [...unread.values()].map(async (list) => {
      const read = await inboxFileCounts(list[0].token, list[0].repo, list.map((p) => p.number));
      for (const p of list) {
        const counts = read.get(p.number);
        if (!counts) continue;
        countsByHead.set(key(p), counts);
        if (countsByHead.size > COUNTS_KEPT) countsByHead.delete(countsByHead.keys().next().value as string);
      }
    }),
  );
  return pulls.map((p) => countsByHead.get(key(p)) ?? null);
}

/** What Outrunner knows of some pull requests: their sessions and items. */
async function outrunnerLinks(
  pulls: { projectId: string; number: number }[],
): Promise<Map<string, { sessionId: string; itemKey: string | null }>> {
  const links = new Map<string, { sessionId: string; itemKey: string | null }>();
  if (pulls.length === 0) return links;
  const db = createSupabaseAdminClient();
  const { data: rows } = await db
    .from("pull_requests")
    .select("workspace_id, project_id, github_number")
    .in("project_id", [...new Set(pulls.map((p) => p.projectId))])
    .in("github_number", [...new Set(pulls.map((p) => p.number))]);
  const sessions = (rows ?? []).map((r) => r.workspace_id);
  const { data: items } = sessions.length
    ? await db.from("work_items").select("number, workspace_id").in("workspace_id", sessions)
    : { data: [] };
  const keyOf = new Map((items ?? []).map((i) => [i.workspace_id, `OR-${i.number}`]));
  for (const r of rows ?? []) {
    links.set(`${r.project_id}#${r.github_number}`, { sessionId: r.workspace_id, itemKey: keyOf.get(r.workspace_id) ?? null });
  }
  return links;
}

/**
 * The open pull requests of the org's repositories the viewer may read (the
 * first 20 repositories), newest activity first, with their checks.
 * `unreachable` names repositories the GitHub App can't read.
 */
export async function listOpenPulls(actor: TriageActor): Promise<{ pulls: PullSummary[]; unreachable: string[] }> {
  const repos = (await readableRepos(actor)).slice(0, 20);
  const unreachable: string[] = [];
  const found: (Omit<PullSummary, "checks" | "lines" | "linesComplete" | "sessionId" | "itemKey"> & { token: string; headSha: string })[] = [];
  await Promise.all(
    repos.map(async (repo) => {
      const token = await repoToken(actor.orgId, repo.fullName).catch(() => null);
      const pulls = token ? await githubGet<GitHubPull[]>(token, `/repos/${repo.fullName}/pulls?state=open&sort=updated&direction=desc&per_page=30`) : null;
      if (!token || !pulls) {
        unreachable.push(repo.fullName);
        return;
      }
      for (const p of pulls) {
        found.push({
          repo: repo.fullName,
          projectId: repo.id,
          number: p.number,
          title: p.title,
          author: p.user?.login ?? null,
          draft: p.draft === true,
          updatedAt: p.updated_at,
          url: p.html_url,
          token,
          headSha: p.head.sha,
        });
      }
    }),
  );
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = found.slice(0, 60);
  const [links, checks, lines] = await Promise.all([
    outrunnerLinks(shown),
    // Checks for the first 30: two GitHub calls each.
    Promise.all(
      shown.map((p, i) =>
        i < 30
          ? getPullRequestStatus({ token: p.token, repoFullName: p.repo, number: p.number }).then(
              (s) => s.checks,
              () => null,
            )
          : Promise.resolve(null),
      ),
    ),
    // And their lines by kind: one call a repository, for those whose head
    // wasn't read before.
    inboxCounts(shown.slice(0, 30)),
  ]);
  return {
    pulls: shown.map((p, i) => {
      const link = links.get(`${p.projectId}#${p.number}`);
      return {
        repo: p.repo,
        projectId: p.projectId,
        number: p.number,
        title: p.title,
        author: p.author,
        draft: p.draft,
        updatedAt: p.updatedAt,
        url: p.url,
        checks: checks[i],
        lines: lines[i]?.lines ?? null,
        linesComplete: lines[i]?.complete ?? false,
        sessionId: link?.sessionId ?? null,
        itemKey: link?.itemKey ?? null,
      };
    }),
    unreachable,
  };
}

export type PullDetail = {
  repo: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Its branch is in a fork, which Outrunner can't push to. */
  fromFork: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Its changed files, with their patches, and their lines by kind; null
   *  when GitHub didn't list them. `filesComplete` is false when only some
   *  were read. */
  files: PullFile[] | null;
  filesComplete: boolean;
  lines: LineCounts | null;
  checks: Checks;
  mergeableState: string;
  reviewers: string[];
  reviews: { author: string; state: string }[];
  /** The code-review automation's score ("Score: 4/5"), and the validator's verdict. */
  reviewScore: string | null;
  verdict: Verdict | null;
  sessionId: string | null;
  /** Whether that session is the viewer's (only its owner can send it work). */
  ownSession: boolean;
  itemKey: string | null;
};

/** The repository, if the viewer may read it: by `owner/name`. */
export async function readableRepo(actor: TriageActor, fullName: string): Promise<{ id: string; fullName: string } | null> {
  const wanted = fullName.toLowerCase();
  return (await readableRepos(actor)).find((r) => r.fullName.toLowerCase() === wanted) ?? null;
}

/** A PR's repository and head, read lightly, for polling and safe change routing. */
export type PullHead = {
  repo: string;
  projectId: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  headRef: string;
  headSha: string;
  baseRef: string;
  fromFork: boolean;
  token: string;
};

export type PullHeadResult = { kind: "found"; pull: PullHead } | { kind: "unreadable" } | { kind: "unavailable" };

/** A PR's repository and head, read lightly (one GitHub call), for what polls
 *  it. Distinguishes an unreadable/missing PR from a temporary GitHub failure. */
export async function pullHead(
  actor: TriageActor,
  fullName: string,
  number: number,
): Promise<PullHeadResult> {
  let repo: { id: string; fullName: string } | null;
  try {
    repo = await readableRepo(actor, fullName);
  } catch {
    return { kind: "unavailable" };
  }
  if (!repo || !Number.isInteger(number) || number < 1) return { kind: "unreadable" };
  let token: string | null;
  try {
    token = await repoToken(actor.orgId, repo.fullName);
  } catch {
    return { kind: "unavailable" };
  }
  if (!token) return { kind: "unreadable" };
  const result = await githubGetResult<GitHubPull>(token, `/repos/${repo.fullName}/pulls/${number}`);
  if (!result.value) {
    return result.retryable ? { kind: "unavailable" } : { kind: "unreadable" };
  }
  const pull = result.value;
  return {
    kind: "found",
    pull: {
      repo: repo.fullName,
      projectId: repo.id,
      number,
      title: pull.title,
      url: pull.html_url,
      state: pull.merged || pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      fromFork: (pull.head.repo?.full_name ?? "").toLowerCase() !== repo.fullName.toLowerCase(),
      token,
    },
  };
}

/** How long a PR's page waits to ask GitHub again whether it merges cleanly. */
const MERGEABILITY_RETRY_MS = 1500;

/** One pull request in full, or null when the viewer may not read it. */
export async function pullDetail(actor: TriageActor, fullName: string, number: number): Promise<PullDetail | null> {
  const repo = await readableRepo(actor, fullName);
  if (!repo || !Number.isInteger(number) || number < 1) return null;
  const token = await repoToken(actor.orgId, repo.fullName);
  if (!token) return null;
  const base = `/repos/${repo.fullName}`;
  const [pull, status, reviews, comments, links, files] = await Promise.all([
    githubGet<GitHubPull>(token, `${base}/pulls/${number}`),
    getPullRequestStatus({ token, repoFullName: repo.fullName, number }).catch(() => null),
    githubGet<{ user?: { login?: string }; state: string }[]>(token, `${base}/pulls/${number}/reviews?per_page=50`),
    githubGet<{ body?: string | null; user?: { login?: string; type?: string } | null }[]>(
      token,
      `${base}/issues/${number}/comments?sort=created&direction=desc&per_page=50`,
    ),
    outrunnerLinks([{ projectId: repo.id, number }]),
    pullFiles(token, repo.fullName, number),
  ]);
  if (!pull) return null;
  // GitHub works out whether a PR merges cleanly only once asked, so a PR no
  // one has looked at lately reads "unknown" at first: asked once more, a
  // moment later, so its page can offer Merge, or say why not.
  let mergeStatus = status;
  if (mergeStatus?.state === "open" && mergeStatus.mergeableState === "unknown") {
    await new Promise((resolve) => setTimeout(resolve, MERGEABILITY_RETRY_MS));
    mergeStatus = await getPullRequestStatus({ token, repoFullName: repo.fullName, number }).catch(() => status);
  }
  const config = githubAppConfig();
  const slug = config ? await appSlug(config).catch(() => null) : null;
  const fromApp = (c: { user?: { login?: string; type?: string } | null }) =>
    slug ? c.user?.login === `${slug}[bot]` : c.user?.type === "Bot";
  const appComments = (comments ?? []).filter(fromApp);
  const score = appComments.map((c) => /Score:\s*(\d(?:\.\d)?\s*\/\s*5)/i.exec(c.body ?? "")?.[1]).find(Boolean) ?? null;
  const verdict = appComments.map((c) => parseVerdict(c.body ?? "")).find(Boolean) ?? null;
  const link = links.get(`${repo.id}#${number}`);
  let ownSession = false;
  if (link?.sessionId) {
    const { data } = await createSupabaseAdminClient().from("workspaces").select("owner_id").eq("id", link.sessionId).maybeSingle();
    ownSession = data?.owner_id === actor.userId;
  }
  // The latest review of each reviewer.
  const latest = new Map<string, string>();
  for (const r of reviews ?? []) if (r.user?.login) latest.set(r.user.login, r.state);
  return {
    repo: repo.fullName,
    projectId: repo.id,
    number,
    title: pull.title,
    body: pull.body ?? "",
    url: pull.html_url,
    author: pull.user?.login ?? null,
    state: pull.merged || pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
    draft: pull.draft === true,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    fromFork: (pull.head.repo?.full_name ?? "").toLowerCase() !== repo.fullName.toLowerCase(),
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
    files: files?.files ?? null,
    // Every file read: the pages ran out, or as many came as GitHub counts
    // (a PR of exactly the cap's number of files).
    filesComplete: filesReadComplete(files, pull.changed_files ?? Number.POSITIVE_INFINITY),
    lines: files ? countLines(files.files) : null,
    checks: mergeStatus?.checks ?? { passing: 0, failing: 0, pending: 0 },
    mergeableState: mergeStatus?.mergeableState ?? "unknown",
    reviewers: (pull.requested_reviewers ?? []).flatMap((r) => (r.login ? [r.login] : [])),
    reviews: [...latest].map(([author, state]) => ({ author, state })),
    reviewScore: score ? score.replace(/\s+/g, "") : null,
    verdict,
    sessionId: link?.sessionId ?? null,
    ownSession,
    itemKey: link?.itemKey ?? null,
  };
}
