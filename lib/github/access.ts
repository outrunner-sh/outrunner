import type { GitHubOrgMemberships, GitHubRepositoryInvitation } from "@/lib/github/client";

/**
 * Why repositories the user expects may be missing from the picker, read from
 * what GitHub said alongside the listing. Kept free of request code so the
 * picker can import the types.
 *
 * GitHub never says outright that an organization holds repositories back
 * from Outrunner: an organization that has not approved Outrunner's OAuth app
 * is answered "as if the user is not a member", its private repositories
 * simply left out. So beyond what GitHub does say (single sign-on), these are
 * hints, worded as questions, with the page on GitHub that settles it.
 */

/** An organization whose repositories may be held back. */
export type OrgAccessHint = {
  /** Null for an organization GitHub named only by id. */
  login: string | null;
  avatarUrl: string | null;
  /**
   * `sso`: GitHub left its repositories out until the token is authorized for
   * the organization's single sign-on. `no-repos`: the user is a member, yet
   * none of its repositories are listed — most often because the
   * organization has not approved Outrunner.
   */
  reason: "sso" | "no-repos";
};

/** An invitation waiting on GitHub: to join an organization, or to a repository. */
export type GitHubInvite = {
  key: string;
  /** The organization's login, or the repository's `owner/name`. */
  name: string;
  avatarUrl: string | null;
  detail: string;
  acceptUrl: string;
};

/** What the picker shows about repositories it may not be listing. */
export type RepositoryAccess = {
  hints: OrgAccessHint[];
  invites: GitHubInvite[];
  /** The token predates Outrunner asking for `read:org`; signing in again
   *  lets the picker check the user's organizations. */
  needsOrgScope: boolean;
  /** Where on GitHub the user grants Outrunner an organization's access. */
  reviewUrl: string;
};

/**
 * GitHub's page for Outrunner's OAuth app, where each organization is listed
 * with Grant (an owner) or Request (a member) — or, without the app's client
 * id, the list of every app the user has authorized.
 */
export function githubAccessReviewUrl(clientId: string | undefined): string {
  const id = clientId?.trim();
  return id
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(id)}`
    : "https://github.com/settings/applications";
}

export function repositoryAccess(input: {
  /** Owners of the repositories listed. */
  repositories: readonly { owner: string }[];
  complete: boolean;
  ssoPartialOrgIds: readonly number[];
  /** Null when they could not be read: nothing is said about organizations. */
  memberships: GitHubOrgMemberships | null;
  invitations: readonly GitHubRepositoryInvitation[];
  clientId?: string;
}): RepositoryAccess {
  const orgs = input.memberships?.canReadOrgs ? input.memberships.orgs : [];
  const owners = new Set(input.repositories.map((repo) => repo.owner.toLowerCase()));
  const sso = new Set(input.ssoPartialOrgIds);

  const hints: OrgAccessHint[] = [];
  for (const org of orgs) {
    if (org.state !== "active") continue;
    if (sso.has(org.id)) {
      hints.push({ login: org.login, avatarUrl: org.avatarUrl, reason: "sso" });
      sso.delete(org.id);
    } else if (input.complete && !owners.has(org.login.toLowerCase())) {
      // Only from a complete listing: from a short one, absence means nothing.
      hints.push({ login: org.login, avatarUrl: org.avatarUrl, reason: "no-repos" });
    }
  }
  // Organizations single sign-on left out that the memberships didn't name
  // (or couldn't be read): one hint stands for them all.
  if (sso.size > 0) hints.push({ login: null, avatarUrl: null, reason: "sso" });

  const invites: GitHubInvite[] = [
    ...orgs
      .filter((org) => org.state === "pending")
      .map((org) => ({
        key: `org:${org.id}`,
        name: org.login,
        avatarUrl: org.avatarUrl,
        detail: "Invited to join the organization",
        acceptUrl: `https://github.com/orgs/${encodeURIComponent(org.login)}/invitation`,
      })),
    ...input.invitations.map((invitation) => ({
      key: `repo:${invitation.id}`,
      name: invitation.fullName,
      avatarUrl: invitation.avatarUrl,
      detail: invitation.inviter ? `Invited by ${invitation.inviter}` : "Invited to collaborate",
      acceptUrl: `https://github.com/${invitation.fullName}/invitations`,
    })),
  ];

  return {
    hints,
    invites,
    needsOrgScope: input.memberships?.canReadOrgs === false,
    reviewUrl: githubAccessReviewUrl(input.clientId),
  };
}
