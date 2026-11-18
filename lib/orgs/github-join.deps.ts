/**
 * Real wiring for lib/orgs/github-join.ts: the user's GitHub connection, the
 * database, and GitHub, as the user (their installations) and as each
 * installation (its organization's members).
 */

import { sourceOrgInstallations } from "@/lib/db/github-installations";
import { joinStanding } from "@/lib/db/org-members";
import { githubAppConfig } from "@/lib/github/app";
import { appOrgMember } from "@/lib/github/installation-owner";
import { listUserInstallations, userOfToken } from "@/lib/github/user-auth";
import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";
import { githubUserToken, userAuthConfigured } from "@/lib/github/user-connection.deps";
import type { GitHubJoinDeps } from "@/lib/orgs/github-join";

export const githubJoinDeps: GitHubJoinDeps = {
  async userToken(userId) {
    // Without the App's user authorization there's no token to look with.
    if (!userAuthConfigured()) return null;
    try {
      return (await githubUserToken(userId))?.token ?? null;
    } catch (error) {
      // Broken: connecting again is the way, as for no connection at all.
      if (error instanceof GitHubConnectionBrokenError) return null;
      throw error;
    }
  },
  githubUser: (token) => userOfToken(token),
  installations: (token) => listUserInstallations(token),
  sourceOrgsOf: (installationIds) => sourceOrgInstallations({ installationIds }),
  sourceInstallationsOf: (orgId) => sourceOrgInstallations({ orgId }),
  standing: joinStanding,
  async activeMember(installationId, githubOrg, user) {
    const config = githubAppConfig();
    if (!config) return false;
    try {
      return await appOrgMember(config)(installationId, githubOrg, user);
    } catch (error) {
      // Taken as no (github-join.ts fails closed); said here, as it isn't
      // GitHub's answer but its silence.
      console.error(`GitHub: couldn't confirm membership of ${githubOrg} (installation ${installationId})`, error);
      return false;
    }
  },
};
