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

async function fetchGitHub(url: URL, token: string): Promise<Response> {
  return githubRequest("GET", url, token);
}

async function githubRequest(
  method: "GET" | "POST",
  url: URL,
  token: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("GitHub request failed", error);
    throw new GitHubSyncError("Could not reach GitHub. Please try again.");
  }
}

/**
 * GitHub said no. A 401 or 403 means the token itself (expired, revoked, or
 * out of rate limit), which the user fixes by reconnecting or waiting, so it
 * gets that message; anything else gets `message`.
 */
function rejected(response: Response, what: string, message: string): GitHubSyncError {
  console.error(`GitHub ${what} was rejected`, { status: response.status });
  return new GitHubSyncError(
    response.status === 401 || response.status === 403
      ? "GitHub could not authorize the configured token."
      : message,
    response.status,
  );
}

/**
 * The GitHub login that owns `token`, read from `/user`. Used by the publish
 * path to confirm a stored per-user token still belongs to the account that
 * granted it.
 */
async function fetchTokenLogin(token: string): Promise<string> {
  const identity = await fetchGitHub(new URL("/user", GITHUB_API_URL), token);
  if (!identity.ok) {
    console.error("GitHub token identity request was rejected", {
      status: identity.status,
    });
    throw new GitHubSyncError("GitHub could not authorize the configured token.");
  }

  let login: unknown;
  try {
    login = ((await identity.json()) as { login?: unknown }).login;
  } catch (error) {
    console.error("GitHub returned an unreadable token identity", error);
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }

  if (typeof login !== "string") {
    throw new GitHubSyncError("GitHub returned an invalid response.");
  }
  return login;
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
// Organizations and invitations: why a repository may be missing from the list.
// ---------------------------------------------------------------------------

/** An organization the user belongs to, or has been invited to. */
export type GitHubOrgMembership = {
  id: number;
  login: string;
  avatarUrl: string | null;
  /** `pending`: invited, not yet accepted on GitHub. */
  state: "active" | "pending";
};

/**
 * The user's organizations, or `canReadOrgs: false` when the token was granted
 * before Outrunner asked for `read:org` — signing in again grants it.
 */
export type GitHubOrgMemberships =
  | { canReadOrgs: false }
  | { canReadOrgs: true; orgs: GitHubOrgMembership[] };

/** An invitation to collaborate on a repository, not yet accepted. */
export type GitHubRepositoryInvitation = {
  id: number;
  fullName: string;
  avatarUrl: string | null;
  inviter: string | null;
};

const ORG_SCOPES = ["read:org", "write:org", "admin:org"];

/**
 * Whether the token may read org memberships, from GitHub's `X-OAuth-Scopes`
 * header. No header at all is a token without OAuth scopes (a fine-grained or
 * app token), whose access the response itself shows.
 */
function hasOrgScope(scopesHeader: string | null): boolean {
  if (scopesHeader === null) return true;
  return scopesHeader.split(",").some((scope) => ORG_SCOPES.includes(scope.trim()));
}

/**
 * The organizations the user belongs to or is invited to (the first 100: far
 * more than one person is in).
 */
export async function listOrgMemberships(token: string): Promise<GitHubOrgMemberships> {
  const url = new URL("/user/memberships/orgs", GITHUB_API_URL);
  url.searchParams.set("per_page", String(PER_PAGE));

  const response = await fetchGitHub(url, token);
  if (!hasOrgScope(response.headers.get("x-oauth-scopes"))) return { canReadOrgs: false };
  if (!response.ok) {
    throw rejected(response, "organization membership request", "GitHub could not list your organizations.");
  }

  const records = await readJson(response);
  if (!Array.isArray(records)) throw new GitHubSyncError("GitHub returned an invalid response.");

  const orgs: GitHubOrgMembership[] = [];
  for (const record of records) {
    const membership = (record ?? {}) as {
      state?: unknown;
      organization?: { id?: unknown; login?: unknown; avatar_url?: unknown };
    };
    const org = membership.organization;
    if (
      (membership.state !== "active" && membership.state !== "pending") ||
      typeof org?.id !== "number" ||
      !nonEmpty(org.login)
    ) {
      continue;
    }
    orgs.push({
      id: org.id,
      login: org.login,
      avatarUrl: nonEmpty(org.avatar_url) ? org.avatar_url : null,
      state: membership.state,
    });
  }
  return { canReadOrgs: true, orgs };
}

/** The user's open invitations to collaborate on repositories (the first 100). */
export async function listRepositoryInvitations(token: string): Promise<GitHubRepositoryInvitation[]> {
  const url = new URL("/user/repository_invitations", GITHUB_API_URL);
  url.searchParams.set("per_page", String(PER_PAGE));

  const response = await fetchGitHub(url, token);
  if (!response.ok) {
    throw rejected(response, "repository invitation request", "GitHub could not list your invitations.");
  }

  const records = await readJson(response);
  if (!Array.isArray(records)) throw new GitHubSyncError("GitHub returned an invalid response.");

  const invitations: GitHubRepositoryInvitation[] = [];
  for (const record of records) {
    const invitation = (record ?? {}) as {
      id?: unknown;
      repository?: { full_name?: unknown; owner?: { avatar_url?: unknown } };
      inviter?: { login?: unknown } | null;
    };
    const fullName = invitation.repository?.full_name;
    if (typeof invitation.id !== "number" || !nonEmpty(fullName) || !isGitHubFullName(fullName)) continue;
    const avatar = invitation.repository?.owner?.avatar_url;
    const inviter = invitation.inviter?.login;
    invitations.push({
      id: invitation.id,
      fullName,
      avatarUrl: nonEmpty(avatar) ? avatar : null,
      inviter: nonEmpty(inviter) ? inviter : null,
    });
  }
  return invitations;
}

// ---------------------------------------------------------------------------
// M9 publish: verify the token owner, then find-or-create one pull request.
// ---------------------------------------------------------------------------

export type WorkspacePullRequestRef = { number: number; url: string };

/**
 * Re-confirm the user's stored GitHub token still belongs to them, immediately
 * before it is used to push a branch and open a PR.
 *
 * Still worth doing now that tokens are per-user: a stored provider_token can
 * be revoked from GitHub's side, or go stale against an account rename. Failing
 * here produces "reconnect your GitHub account" instead of a confusing 401 from
 * the middle of a push.
 */
export async function verifyTokenOwner(
  token: string,
  expectedOwnerLogin: string,
): Promise<void> {
  const tokenLogin = await fetchTokenLogin(token);
  if (tokenLogin.toLowerCase() !== expectedOwnerLogin.toLowerCase()) {
    throw new GitHubSyncError(
      "Your GitHub connection is out of date. Sign out and back in to reconnect.",
    );
  }
}

/**
 * Return the existing open PR for `headBranch`, or create one. Making this
 * idempotent (lookup before create, and re-lookup on GitHub's 422 for an
 * already-existing PR) lets the publish route retry safely.
 */
export async function findOrCreatePullRequest(input: {
  token: string;
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<WorkspacePullRequestRef> {
  const { token } = input;
  const [owner] = input.repoFullName.split("/");

  const existing = await findOpenPullRequest(input, owner, token);
  if (existing) return existing;

  const response = await githubRequest(
    "POST",
    new URL(`/repos/${input.repoFullName}/pulls`, GITHUB_API_URL),
    token,
    {
      title: input.title,
      head: input.headBranch,
      base: input.baseBranch,
      body: input.body,
    },
  );

  if (response.status === 422) {
    // A concurrent publish, or "no commits between base and head".
    const retried = await findOpenPullRequest(input, owner, token);
    if (retried) return retried;
    throw new GitHubSyncError(
      "GitHub could not open a pull request. Ensure the branch has commits that differ from the base.",
      422,
    );
  }
  if (!response.ok) {
    console.error("GitHub pull request creation was rejected", {
      status: response.status,
    });
    throw new GitHubSyncError(
      response.status === 401 || response.status === 403
        ? "GitHub could not authorize the configured token."
        : "GitHub could not open a pull request. Please try again.",
      response.status,
    );
  }
  return toPullRequestRef(await readJson(response));
}

async function findOpenPullRequest(
  input: { repoFullName: string; headBranch: string; baseBranch: string },
  owner: string,
  token: string,
): Promise<WorkspacePullRequestRef | null> {
  const url = new URL(`/repos/${input.repoFullName}/pulls`, GITHUB_API_URL);
  url.searchParams.set("head", `${owner}:${input.headBranch}`);
  url.searchParams.set("base", input.baseBranch);
  url.searchParams.set("state", "open");

  const response = await fetchGitHub(url, token);
  if (!response.ok) {
    console.error("GitHub pull request lookup was rejected", {
      status: response.status,
    });
    throw new GitHubSyncError(
      "GitHub could not look up existing pull requests. Please try again.",
      response.status,
    );
  }
  const list = await readJson(response);
  if (!Array.isArray(list) || list.length === 0) return null;
  return toPullRequestRef(list[0]);
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
  const pr = (record ?? {}) as { number?: unknown; html_url?: unknown };
  if (
    typeof pr.number !== "number" ||
    !Number.isInteger(pr.number) ||
    typeof pr.html_url !== "string"
  ) {
    throw new GitHubSyncError("GitHub returned an invalid pull request record.");
  }
  return { number: pr.number, url: pr.html_url };
}
