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
import { githubGet, repoToken } from "@/lib/slack/github";
import { parseVerdict, type Verdict } from "@/lib/slack/proactive-text";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { TriageActor } from "@/lib/triage/access";

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
  head: { ref: string; sha: string };
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
  const found: (Omit<PullSummary, "checks" | "sessionId" | "itemKey"> & { token: string })[] = [];
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
        });
      }
    }),
  );
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = found.slice(0, 60);
  const [links, checks] = await Promise.all([
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
  additions: number;
  deletions: number;
  changedFiles: number;
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

/** How long a PR's page waits to ask GitHub again whether it merges cleanly. */
const MERGEABILITY_RETRY_MS = 1500;

/** One pull request in full, or null when the viewer may not read it. */
export async function pullDetail(actor: TriageActor, fullName: string, number: number): Promise<PullDetail | null> {
  const repo = await readableRepo(actor, fullName);
  if (!repo || !Number.isInteger(number) || number < 1) return null;
  const token = await repoToken(actor.orgId, repo.fullName);
  if (!token) return null;
  const base = `/repos/${repo.fullName}`;
  const [pull, status, reviews, comments, links] = await Promise.all([
    githubGet<GitHubPull>(token, `${base}/pulls/${number}`),
    getPullRequestStatus({ token, repoFullName: repo.fullName, number }).catch(() => null),
    githubGet<{ user?: { login?: string }; state: string }[]>(token, `${base}/pulls/${number}/reviews?per_page=50`),
    githubGet<{ body?: string | null; user?: { login?: string; type?: string } | null }[]>(
      token,
      `${base}/issues/${number}/comments?sort=created&direction=desc&per_page=50`,
    ),
    outrunnerLinks([{ projectId: repo.id, number }]),
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
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
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
