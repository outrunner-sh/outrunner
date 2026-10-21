
/** A GitHub repository normalized to the fields Runtime persists. */
export type GitHubRepository = {
  githubRepoId: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  htmlUrl: string;
  pushedAt: string | null;
};

type GitHubApiRepository = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
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
    if (isTokenRejected(identity.status)) {
      throw new GitHubReconnectError(undefined, identity.status);
    }
    throw new GitHubSyncError(
      "GitHub could not verify your account. Please try again.",
      identity.status,
    );
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

function normalizeRepository(repo: GitHubApiRepository): GitHubRepository {
  if (
    !Number.isSafeInteger(repo.id) ||
    repo.id <= 0 ||
    !repo.full_name ||
    !repo.name ||
    !repo.owner?.login ||
    !repo.html_url
  ) {
    throw new GitHubSyncError("GitHub returned an invalid repository record.");
  }

  return {
    githubRepoId: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch || "main",
    private: Boolean(repo.private),
    language: repo.language,
    description: repo.description,
    htmlUrl: repo.html_url,
    pushedAt: repo.pushed_at,
  };
}

/**
 * Retrieves the repositories visible to `token` — the signed-in user's own
 * GitHub credential, captured from their OAuth sign-in.
 *
 * The caller supplies the token rather than this module reading one from the
 * environment: every user syncs their own repositories under their own
 * identity, so there is no server-wide credential to fall back on.
 */
export async function listGitHubRepositories(
  token: string,
): Promise<GitHubRepository[]> {
  const repositories: GitHubRepository[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL("/user/repos", GITHUB_API_URL);
    url.searchParams.set(
      "affiliation",
      "owner,collaborator,organization_member",
    );
    url.searchParams.set("sort", "pushed");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    const response = await fetchGitHub(url, token);

    if (!response.ok) {
      console.error("GitHub repository request was rejected", {
        status: response.status,
      });
      if (isTokenRejected(response.status)) {
        throw new GitHubReconnectError(undefined, response.status);
      }
      throw new GitHubSyncError(
        "GitHub could not list repositories. Please try again.",
        response.status,
      );
    }

    let pageRepositories: GitHubApiRepository[];
    try {
      pageRepositories = (await response.json()) as GitHubApiRepository[];
    } catch (error) {
      console.error("GitHub returned an unreadable repository response", error);
      throw new GitHubSyncError("GitHub returned an invalid response.");
    }

    if (!Array.isArray(pageRepositories)) {
      throw new GitHubSyncError("GitHub returned an invalid response.");
    }

    repositories.push(...pageRepositories.map(normalizeRepository));

    if (pageRepositories.length < PER_PAGE) return repositories;
  }

  throw new GitHubSyncError(
    "Repository sync stopped after 10,000 repositories. Narrow your GitHub app's repository access and try again.",
  );
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
    throw new GitHubReconnectError(
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
    if (isTokenRejected(response.status)) {
      throw new GitHubReconnectError(undefined, response.status);
    }
    throw new GitHubSyncError(
      response.status === 403
        ? "GitHub did not allow opening a pull request on this repository."
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
