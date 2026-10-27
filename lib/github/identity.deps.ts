/**
 * Real wiring for lib/github/identity.ts: the user's choice and token from the
 * credential store, the org's installations, and GitHub. Kept apart so that
 * stays free of the database and unit-testable.
 */

import { getGithubIdentity, getGithubToken } from "@/lib/db/credentials";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig, mintInstallationToken, type InstallationToken } from "@/lib/github/app";
import { MissingGithubTokenError } from "@/lib/github/client";
import {
  resolveGitCredential,
  type GitCredential,
  type GitHubIdentity,
  type IdentityDeps,
} from "@/lib/github/identity";
import type { AccessLevel } from "@/lib/orgs/access";

const tokens = new Map<string, InstallationToken>();

const deps: IdentityDeps = {
  identity: getGithubIdentity,
  personalToken: getGithubToken,
  config: githubAppConfig,
  installations: listOrgInstallations,
  mint: (config, installationId, repo, permissions) =>
    mintInstallationToken(config, installationId, [repo], fetch, permissions),
  cache: tokens,
  now: Date.now,
};

/** {@link resolveGitCredential}, as the app runs it. */
export function gitCredentialFor(input: {
  userId: string;
  orgId: string;
  repo: string;
  level?: AccessLevel;
  identity?: GitHubIdentity;
}): Promise<GitCredential> {
  return resolveGitCredential(input, deps);
}

/** The token alone, for a server call that must have one. */
export async function requireGitToken(userId: string, project: { orgId: string; fullName: string }): Promise<string> {
  return (await gitCredentialFor({ userId, orgId: project.orgId, repo: project.fullName })).token;
}

/**
 * The token, or undefined when there's none to be had (said in the log): for
 * a server call that can do without, such as fetching a mirror the box
 * already has, or a public repository.
 */
export async function optionalGitToken(
  userId: string,
  project: { orgId: string; fullName: string },
): Promise<string | undefined> {
  try {
    return await requireGitToken(userId, project);
  } catch (error) {
    if (!(error instanceof MissingGithubTokenError)) {
      console.warn(`No GitHub token for ${project.fullName}`, error instanceof Error ? error.message : error);
    }
    return undefined;
  }
}

/** A token for each repository of a session of several, as asked. */
export function gitTokensFor(userId: string, orgId: string): (fullName: string) => Promise<string | undefined> {
  return (fullName) => optionalGitToken(userId, { orgId, fullName });
}
