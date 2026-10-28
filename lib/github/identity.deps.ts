/**
 * Real wiring for lib/github/identity.ts: the user's choice and token from the
 * credential store, the org's installations, and GitHub. Kept apart so that
 * stays free of the database and unit-testable.
 */

import { getGithubIdentity, getGithubToken } from "@/lib/db/credentials";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { listOrgProjects, projectLevel } from "@/lib/db/org-access";
import {
  githubAppConfig,
  installationPermissions,
  mintInstallationToken,
  type GitHubAppConfig,
  type InstallationToken,
} from "@/lib/github/app";
import { MissingGithubTokenError } from "@/lib/github/client";
import {
  resolveGitCredential,
  type GitCredential,
  type GitHubIdentity,
  type IdentityDeps,
} from "@/lib/github/identity";
import type { AccessLevel } from "@/lib/orgs/access";

const tokens = new Map<string, InstallationToken>();

/** Installations' grants, asked again after this long: an owner accepting
 *  the App's new permissions is followed within it. */
const GRANTS_TTL_MS = 10 * 60 * 1000;
const grants = new Map<number, { permissions: Record<string, string>; at: number }>();

async function granted(config: GitHubAppConfig, installationId: number): Promise<Record<string, string>> {
  const kept = grants.get(installationId);
  if (kept && Date.now() - kept.at < GRANTS_TTL_MS) return kept.permissions;
  const permissions = await installationPermissions(config, installationId);
  grants.set(installationId, { permissions, at: Date.now() });
  return permissions;
}

async function repoLevel(userId: string, orgId: string, repo: string): Promise<AccessLevel | null> {
  const project = (await listOrgProjects(orgId)).find((p) => p.fullName.toLowerCase() === repo.toLowerCase());
  return project ? projectLevel(userId, project.id) : null;
}

const deps: IdentityDeps = {
  identity: getGithubIdentity,
  personalToken: getGithubToken,
  config: githubAppConfig,
  installations: listOrgInstallations,
  repoLevel,
  granted,
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
