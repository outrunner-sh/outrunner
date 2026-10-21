import { mapWithConcurrency } from "@/lib/concurrency";
import { isGitHubFullName, type RepositoryListing } from "@/lib/github/listing";

/**
 * A GitHub repository normalized to the fields Runtime persists, plus the
 * owner's kind and avatar the pickers show.
 */
export type GitHubRepository = RepositoryListing & {
  defaultBranch: string;
  htmlUrl: string;
};

/** What a listing of the user's repositories found. */
export type GitHubRepositoryList = {
  /** Most recently pushed first. */
  repositories: GitHubRepository[];
  /**
   * Whether this is every repository the token can reach. False when GitHub
   * had more pages than Outrunner reads, or returned a record it could not
   * read: then a repository missing from the list may still be there.
   */
  complete: boolean;
  /**
   * Organizations whose repositories GitHub left out because the token is not
   * authorized for their SAML single sign-on (its `X-GitHub-SSO` header).
   */
  ssoPartialOrgIds: number[];
};

type GitHubApiRepository = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string; type?: string; avatar_url?: string };
  default_branch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
};

/**
 * Deliberately generic error: callers may display its message without leaking
 * a GitHub response body, token metadata, or request URL.
 */
export class GitHubSyncError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubSyncError";
    this.status = status;
  }
}

/**
 * The user has no usable GitHub token. Recoverable, and always by the same
 * action: sign out and back in so the OAuth round trip mints a fresh one.
 *
 * Reached when the user last signed in before the `repo` scope was requested,
 * or when a stored token could not be decrypted (see lib/db/credentials.ts).
 * Lives here, beside the other GitHub errors, so code that maps errors to
 * responses need not pull in the credential store; lib/github/token re-exports it.
 */
export class MissingGithubTokenError extends Error {
  constructor() {
    super("Connect your GitHub account: sign out and back in to grant repository access.");
    this.name = "MissingGithubTokenError";
  }
}

/**
 * GitHub refused the user's stored token: revoked, superseded, or minted for
 * another account. Only a fresh OAuth sign-in replaces it, so routes flag this
 * one and the UI links the user to Settings → Account to reconnect.
 */
export class GitHubReconnectError extends GitHubSyncError {
  constructor(
    message = "Your GitHub connection has expired. Sign out and back in to reconnect.",
    status?: number,
  ) {
    super(message, status);
    this.name = "GitHubReconnectError";
  }
}

/**
 * GitHub no longer accepts the token itself. Only 401: a 403 means a rate limit
 * or a repository this token cannot touch, which reconnecting would not fix.
 */
function isTokenRejected(status: number): boolean {
  return status === 401;
}

const GITHUB_API_URL = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 100;
/** Pages of a listing fetched at once, after the first says how many there are. */
const PAGE_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "runtime-v0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHub(
  url: URL,
  token: string,
  init: { method?: "GET" | "PUT"; body?: unknown } = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        ...githubHeaders(token),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("GitHub request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  }
}

/**
 * GitHub said no. A 401 means the token itself is dead, which only
 * reconnecting fixes; anything else (a 403 rate limit included) gets `message`.
 */
function rejected(response: Response, what: string, message: string): GitHubSyncError {
  console.error(`GitHub ${what} was rejected`, { status: response.status });
  if (isTokenRejected(response.status)) return new GitHubReconnectError(undefined, response.status);
  return new GitHubSyncError(message, response.status);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A repository record from GitHub, or null if it lacks what Runtime needs. */
function normalizeRepository(record: unknown): GitHubRepository | null {
  const repo = (record ?? {}) as Partial<GitHubApiRepository>;
  if (
    typeof repo.id !== "number" ||
    !Number.isSafeInteger(repo.id) ||
    repo.id <= 0 ||
    !nonEmpty(repo.full_name) ||
    !nonEmpty(repo.name) ||
    !nonEmpty(repo.owner?.login) ||
    !nonEmpty(repo.html_url)
  ) {
    return null;
  }
  const ownerType = repo.owner.type;

  return {
    githubRepoId: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    ownerType: ownerType === "Organization" || ownerType === "User" ? ownerType : null,
    avatarUrl: nonEmpty(repo.owner.avatar_url) ? repo.owner.avatar_url : null,
    name: repo.name,
    defaultBranch: repo.default_branch || "main",
    private: Boolean(repo.private),
    language: repo.language ?? null,
    description: repo.description ?? null,
    htmlUrl: repo.html_url,
    pushedAt: repo.pushed_at ?? null,
  };
}

/** The page number of a `Link` header's `rel="last"` URL, if it has one. */
export function lastPageFromLink(link: string | null): number | null {
  const match = link?.match(/<([^>]+)>;\s*rel="last"/);
  if (!match) return null;
  try {
    const page = Number(new URL(match[1]).searchParams.get("page"));
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/**
 * The organizations an `X-GitHub-SSO: partial-results; organizations=1,2`
 * header says were left out. Any other value (or none) leaves out nothing.
 */
export function ssoPartialOrgIds(header: string | null): number[] {
  if (!header?.trim().startsWith("partial-results")) return [];
  const orgs = header.match(/organizations=([\d,\s]+)/)?.[1] ?? "";
  return orgs
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

type RepositoryPage = {
  repositories: GitHubRepository[];
  skipped: number;
  lastPage: number | null;
  ssoPartialOrgIds: number[];
};

async function fetchRepositoryPage(token: string, page: number): Promise<RepositoryPage> {
  const url = new URL("/user/repos", GITHUB_API_URL);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  // By name, not by push: pages fetched side by side must not shift under a
  // push landing mid-listing, or a repository could be read twice and another
  // missed. The list is sorted by push once it is all in.
  url.searchParams.set("sort", "full_name");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));

  const response = await fetchGitHub(url, token);
  if (!response.ok) {
    throw rejected(response, "repository request", "GitHub could not list repositories. Please try again.");
  }

  const records = await readJson(response);
  if (!Array.isArray(records)) {
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }

  const repositories: GitHubRepository[] = [];
  for (const record of records) {
    const repo = normalizeRepository(record);
    if (repo) repositories.push(repo);
  }
  const skipped = records.length - repositories.length;
  if (skipped > 0) {
    console.warn("GitHub returned repository records Runtime could not read", { page, skipped });
  }

  return {
    repositories,
    skipped,
    lastPage: lastPageFromLink(response.headers.get("link")),
    ssoPartialOrgIds: ssoPartialOrgIds(response.headers.get("x-github-sso")),
  };
}

function newestPushFirst(a: GitHubRepository, b: GitHubRepository): number {
  if (a.pushedAt !== b.pushedAt) {
    if (a.pushedAt === null) return 1;
    if (b.pushedAt === null) return -1;
    return a.pushedAt < b.pushedAt ? 1 : -1;
  }
  return a.fullName.localeCompare(b.fullName);
}

/**
 * Retrieves the repositories visible to `token` — the signed-in user's own
 * GitHub credential, captured from their OAuth sign-in: their own, ones they
 * collaborate on, and every one their organizations give them (all of an
 * organization's, for its owners).
 *
 * The first page says how many there are (its `Link` header); the rest are
 * fetched a few at a time. Past {@link MAX_PAGES} pages, or with a record that
 * could not be read, the list comes back with `complete: false` rather than
 * failing, so the user still gets to pick from what was read.
 *
 * The caller supplies the token rather than this module reading one from the
 * environment: every user syncs their own repositories under their own
 * identity, so there is no server-wide credential to fall back on.
 */
export async function listGitHubRepositories(token: string): Promise<GitHubRepositoryList> {
  const first = await fetchRepositoryPage(token, 1);
  const lastPage = first.lastPage ?? 1;
  const morePages = Array.from({ length: Math.min(lastPage, MAX_PAGES) - 1 }, (_, i) => i + 2);
  const pages = [
    first,
    ...(await mapWithConcurrency(morePages, PAGE_CONCURRENCY, (page) => fetchRepositoryPage(token, page))),
  ];

  // A repository created or deleted mid-listing can shift one onto two pages.
  const byId = new Map<number, GitHubRepository>();
  for (const page of pages) {
    for (const repo of page.repositories) byId.set(repo.githubRepoId, repo);
  }

  return {
    repositories: [...byId.values()].sort(newestPushFirst),
    complete: lastPage <= MAX_PAGES && pages.every((page) => page.skipped === 0),
    ssoPartialOrgIds: [...new Set(pages.flatMap((page) => page.ssoPartialOrgIds))],
  };
}

/**
 * One repository, by id or `owner/name`, as `token` sees it — or null when it
 * cannot: it does not exist, is private to others, or belongs to an
 * organization whose single sign-on the token is not authorized for (a 403
 * that is not a rate limit).
 *
 * Connecting a picked repository checks it this way rather than listing every
 * repository to find one.
 */
export async function getGitHubRepository(
  token: string,
  ref: number | string,
): Promise<GitHubRepository | null> {
  let path: string;
  if (typeof ref === "number") {
    if (!Number.isSafeInteger(ref) || ref <= 0) return null;
    path = `/repositories/${ref}`;
  } else {
    if (!isGitHubFullName(ref)) return null;
    path = `/repos/${ref}`;
  }

  const response = await fetchGitHub(new URL(path, GITHUB_API_URL), token);
  if (response.status === 404) return null;
  const rateLimited =
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  if (response.status === 403 && !rateLimited) return null;
  if (!response.ok) {
    throw rejected(response, "repository lookup", "GitHub could not look up that repository. Please try again.");
  }

  const repo = normalizeRepository(await readJson(response));
  if (!repo) throw new GitHubSyncError("GitHub returned an invalid repository record.");
  return repo;
}

// ---------------------------------------------------------------------------
// The pull request a session's agent opened for its branch.
// ---------------------------------------------------------------------------

export type WorkspacePullRequestRef = {
  number: number;
  url: string;
  title: string;
  baseBranch: string;
};

/**
 * The newest pull request from `headBranch` in the repository, open or not, or
 * null when there is none. The agent opens it (Create PR asks it to), so this
 * only looks: a merged or closed one still counts, since a session's branch is
 * its own and never reused.
 */
export async function findPullRequest(input: {
  token: string;
  repoFullName: string;
  headBranch: string;
}): Promise<WorkspacePullRequestRef | null> {
  const [owner] = input.repoFullName.split("/");
  const url = new URL(`/repos/${input.repoFullName}/pulls`, GITHUB_API_URL);
  url.searchParams.set("head", `${owner}:${input.headBranch}`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "created");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "1");

  const response = await fetchGitHub(url, input.token);
  if (!response.ok) {
    throw rejected(response, "pull request lookup", "GitHub could not look up the pull request. Please try again.");
  }
  const list = await readJson(response);
  if (!Array.isArray(list) || list.length === 0) return null;
  return toPullRequestRef(list[0]);
}

/** Where a pull request stands: its state, what GitHub says of merging it
 *  (`mergeable_state`: clean, unstable, blocked, behind, dirty, draft,
 *  has_hooks, unknown), and its head commit's checks. */
export type PullRequestStatus = {
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeableState: string;
  headSha: string;
  checks: { passing: number; failing: number; pending: number };
};

/** A check run's or commit status's outcome, as the three a summary counts. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/**
 * A pull request's status, with its head commit's checks: GitHub Actions'
 * check runs and the older commit statuses some CI still posts, counted
 * together.
 */
export async function getPullRequestStatus(input: {
  token: string;
  repoFullName: string;
  number: number;
}): Promise<PullRequestStatus> {
  const repo = `/repos/${input.repoFullName}`;
  const response = await fetchGitHub(new URL(`${repo}/pulls/${input.number}`, GITHUB_API_URL), input.token);
  if (!response.ok) {
    throw rejected(response, "pull request status", "GitHub could not read the pull request. Please try again.");
  }
  const pr = (await readJson(response)) as {
    state?: unknown;
    merged?: unknown;
    draft?: unknown;
    mergeable_state?: unknown;
    head?: { sha?: unknown };
  };
  const headSha = pr.head?.sha;
  if (typeof headSha !== "string" || (pr.state !== "open" && pr.state !== "closed")) {
    throw new GitHubSyncError("GitHub returned an invalid pull request record.");
  }

  const checksUrl = new URL(`${repo}/commits/${headSha}/check-runs`, GITHUB_API_URL);
  checksUrl.searchParams.set("per_page", "100");
  const [runs, statuses] = await Promise.all([
    fetchGitHub(checksUrl, input.token),
    fetchGitHub(new URL(`${repo}/commits/${headSha}/status`, GITHUB_API_URL), input.token),
  ]);
  if (!runs.ok) throw rejected(runs, "check runs", "GitHub could not read the pull request's checks. Please try again.");
  if (!statuses.ok) throw rejected(statuses, "commit status", "GitHub could not read the pull request's checks. Please try again.");

  const checks = { passing: 0, failing: 0, pending: 0 };
  const runList = ((await readJson(runs)) as { check_runs?: { status?: unknown; conclusion?: unknown }[] }).check_runs ?? [];
  for (const run of runList) {
    if (run.status !== "completed") checks.pending += 1;
    else if (FAILED_CONCLUSIONS.has(String(run.conclusion))) checks.failing += 1;
    else checks.passing += 1;
  }
  // Each status, not the combined `state`: that reads "pending" when there are none.
  const statusList = ((await readJson(statuses)) as { statuses?: { state?: unknown }[] }).statuses ?? [];
  for (const status of statusList) {
    if (status.state === "pending") checks.pending += 1;
    else if (status.state === "success") checks.passing += 1;
    else checks.failing += 1;
  }

  return {
    state: pr.merged === true ? "merged" : pr.state,
    draft: pr.draft === true,
    mergeableState: typeof pr.mergeable_state === "string" ? pr.mergeable_state : "unknown",
    headSha,
    checks,
  };
}

/**
 * Merge a pull request at `headSha`, the commit the user saw pass: should the
 * branch have moved since, GitHub refuses (409) rather than merge what nobody
 * looked at. The method is the first the repository allows of a merge commit,
 * a squash and a rebase. GitHub's own reason for a refusal is the message.
 */
export async function mergePullRequest(input: {
  token: string;
  repoFullName: string;
  number: number;
  headSha: string;
}): Promise<void> {
  const repoResponse = await fetchGitHub(new URL(`/repos/${input.repoFullName}`, GITHUB_API_URL), input.token);
  if (!repoResponse.ok) {
    throw rejected(repoResponse, "repository lookup", "GitHub could not look up that repository. Please try again.");
  }
  const repo = (await readJson(repoResponse)) as Record<string, unknown>;
  const method = mergeMethod(repo);
  if (!method) throw new GitHubSyncError("This repository allows no way of merging a pull request.");

  const response = await fetchGitHub(
    new URL(`/repos/${input.repoFullName}/pulls/${input.number}/merge`, GITHUB_API_URL),
    input.token,
    { method: "PUT", body: { sha: input.headSha, merge_method: method } },
  );
  if (response.ok) return;
  if (response.status === 405 || response.status === 409 || response.status === 422) {
    const reason = ((await response.json().catch(() => ({}))) as { message?: unknown }).message;
    console.error("GitHub merge was refused", { status: response.status, reason });
    throw new GitHubSyncError(
      typeof reason === "string" && reason ? `GitHub could not merge: ${reason}` : "GitHub could not merge this pull request.",
      response.status,
    );
  }
  throw rejected(response, "merge", "GitHub could not merge this pull request. Please try again.");
}

/** The first merge method a repository record allows, merge commit first. */
export function mergeMethod(repo: Record<string, unknown>): "merge" | "squash" | "rebase" | null {
  if (repo.allow_merge_commit !== false) return "merge";
  if (repo.allow_squash_merge !== false) return "squash";
  if (repo.allow_rebase_merge !== false) return "rebase";
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    console.error("GitHub returned an unreadable response", error);
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }
}

function toPullRequestRef(record: unknown): WorkspacePullRequestRef {
  const pr = (record ?? {}) as {
    number?: unknown;
    html_url?: unknown;
    title?: unknown;
    base?: { ref?: unknown };
  };
  if (
    typeof pr.number !== "number" ||
    !Number.isInteger(pr.number) ||
    typeof pr.html_url !== "string" ||
    typeof pr.title !== "string" ||
    typeof pr.base?.ref !== "string"
  ) {
    throw new GitHubSyncError("GitHub returned an invalid pull request record.");
  }
  return { number: pr.number, url: pr.html_url, title: pr.title, baseBranch: pr.base.ref };
}
