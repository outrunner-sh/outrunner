/**
 * Who may connect a GitHub App installation to an Outrunner org, as GitHub
 * says: its installer, or an owner of the account it's installed on (the
 * account itself, for a user account; an organization owner, for an
 * organization). Administering another Outrunner org that uses it grants
 * nothing (20261112130000_github_installation_sharing.sql).
 *
 * Asked of GitHub as the installation: an organization's owners need the
 * App's "Members: Read" organization permission
 * (`GET /orgs/{org}/memberships/{username}`). An installation without it
 * answers 403, and only its installer can connect it: this fails closed.
 *
 * The GitHub calls take their fetch, for tests.
 */

import { type GitHubAppConfig, GitHubAppError, type Installation, installationToken } from "@/lib/github/app";

type Fetch = typeof fetch;

const API = "https://api.github.com";

/** What GitHub vouched for about a GitHub user, beyond being the installer. */
export type GitHubOwnership = "account_owner" | "org_owner";

/** The identity a link is made with, and what GitHub said of it: null
 *  authority for the recorded installer (the database checks that itself),
 *  or when nothing qualifies. */
export type LinkIdentity = { githubId: number | null; verifiedOwner: GitHubOwnership | null };

async function get<T>(doFetch: Fetch, path: string, token: string): Promise<T | null> {
  const response = await doFetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "outrunner",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  // A rate limit is GitHub not answering, not a no: an error, said as one, rather than an
  // "only the installer" refusal and a pointless sign-in round trip.
  if (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))) {
    throw new GitHubAppError(`GitHub rate-limited GET ${path.split("/").slice(0, 3).join("/")}`, 403);
  }
  // Not found, or not permitted (the App lacks Members: Read): not an owner.
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new GitHubAppError(`GitHub answered ${response.status} to GET ${path.split("/").slice(0, 3).join("/")}`, response.status);
  return (await response.json()) as T;
}

/**
 * Whether GitHub user `githubId` owns the installation's account: is that
 * user account, or is an active owner of that organization. Null when not,
 * or when GitHub won't say.
 */
export async function githubOwnership(
  installation: Pick<Installation, "id" | "accountLogin" | "accountType" | "accountId">,
  githubId: number,
  token: () => Promise<string>,
  doFetch: Fetch = fetch,
): Promise<GitHubOwnership | null> {
  if (installation.accountType === "User") {
    return installation.accountId != null && installation.accountId === githubId ? "account_owner" : null;
  }
  const auth = await token();
  // Logins can be renamed and reused; the id can't. Ask GitHub whose it is now.
  const user = await get<{ id?: unknown; login?: unknown }>(doFetch, `/user/${githubId}`, auth);
  if (!user || user.id !== githubId || typeof user.login !== "string") return null;
  const membership = await get<{ state?: unknown; role?: unknown; user?: { id?: unknown } | null }>(
    doFetch,
    `/orgs/${encodeURIComponent(installation.accountLogin)}/memberships/${encodeURIComponent(user.login)}`,
    auth,
  );
  if (!membership || membership.state !== "active" || membership.role !== "admin") return null;
  if (membership.user && membership.user.id !== githubId) return null;
  return "org_owner";
}

/**
 * Which of the user's GitHub accounts (the ones GitHub vouched are theirs:
 * their sign-in, their connection) to connect with: the installer if one is,
 * else the first GitHub says owns the account, else the first (which the
 * database will refuse, saying why).
 */
export async function linkIdentity(
  githubIds: Array<number | null | undefined>,
  installerId: number | null,
  ownership: (githubId: number) => Promise<GitHubOwnership | null>,
): Promise<LinkIdentity> {
  const ids = [...new Set(githubIds.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
  if (installerId !== null && ids.includes(installerId)) return { githubId: installerId, verifiedOwner: null };
  for (const id of ids) {
    const owned = await ownership(id);
    if (owned) return { githubId: id, verifiedOwner: owned };
  }
  return { githubId: ids[0] ?? null, verifiedOwner: null };
}

/** {@link githubOwnership} as the App, with the installation's own token. */
export function appOwnership(config: GitHubAppConfig, installation: Installation, doFetch: Fetch = fetch) {
  return (githubId: number) =>
    githubOwnership(installation, githubId, () => installationToken(config, installation.id, doFetch), doFetch);
}
