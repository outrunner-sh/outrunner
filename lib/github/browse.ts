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
  /** Null when GitHub could not be asked: the picker then says nothing about
   *  organizations rather than something wrong. */
  memberships: GitHubOrgMemberships | null;
  invitations: GitHubRepositoryInvitation[];
};

/**
 * The user's repositories, with their organizations and open invitations
 * read alongside. Only the listing must succeed: the other two only add
 * notes to it, so their failures are logged and left out.
 */
export async function loadRepositoryBrowse(token: string): Promise<RepositoryBrowse> {
  const [list, memberships, invitations] = await Promise.all([
    listGitHubRepositories(token),
    listOrgMemberships(token).catch((error: unknown) => {
      console.error("Could not read the user's GitHub organizations", error);
      return null;
    }),
    listRepositoryInvitations(token).catch((error: unknown) => {
      console.error("Could not read the user's GitHub invitations", error);
      return [];
    }),
  ]);
  return { list, memberships, invitations };
}
