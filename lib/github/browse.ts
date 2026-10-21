import {
  listGitHubRepositories,
  listOrgMemberships,
  listRepositoryInvitations,
  type GitHubOrgMemberships,
  type GitHubRepositoryInvitation,
  type GitHubRepositoryList,
} from "@/lib/github/client";

/** Everything the repository picker reads from GitHub in one go. */
export type RepositoryBrowse = {
  list: GitHubRepositoryList;
  /** Null when GitHub could not be asked (or took too long): the picker then
   *  says nothing about organizations rather than something wrong. */
  memberships: GitHubOrgMemberships | null;
  invitations: GitHubRepositoryInvitation[];
};

/**
 * How long the organizations and invitations may hold up the listing: they
 * get this long, or as long as the listing takes, whichever is longer, then
 * the listing comes back without their notes.
 */
export const OPTIONAL_READ_BUDGET_MS = 3_000;

/**
 * The user's repositories, with their organizations and open invitations
 * read alongside. Only the listing must succeed: the other two only add
 * notes to it, so a failure or a slow answer leaves their notes out.
 */
export async function loadRepositoryBrowse(
  token: string,
  budgetMs = OPTIONAL_READ_BUDGET_MS,
): Promise<RepositoryBrowse> {
  const listing = listGitHubRepositories(token);
  // Done once the listing is in and the budget has passed.
  const budget = Promise.all([
    listing.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);

  function optional<T>(read: Promise<T>, fallback: T, what: string): Promise<T> {
    let settled = false;
    return Promise.race([
      read
        .catch((error: unknown) => {
          console.error(`Could not read the user's GitHub ${what}`, error);
          return fallback;
        })
        .finally(() => {
          settled = true;
        }),
      budget.then(() => {
        if (!settled) console.warn(`The user's GitHub ${what} took too long; listing without them`);
        return fallback;
      }),
    ]);
  }

  const [list, memberships, invitations] = await Promise.all([
    listing,
    optional<GitHubOrgMemberships | null>(listOrgMemberships(token), null, "organizations"),
    optional<GitHubRepositoryInvitation[]>(listRepositoryInvitations(token), [], "invitations"),
  ]);
  return { list, memberships, invitations };
}
