/**
 * Real wiring for lib/github/identity.ts: the user's choice and token from the
 * credential store, the org's installations, and GitHub. Kept apart so that
 * stays free of the database and unit-testable.
 */

import { getGithubIdentity } from "@/lib/db/credentials";
import { personalConnected, personalCredential } from "@/lib/github/personal";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
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
  type TokenLevel,
} from "@/lib/github/identity";
import type { AccessLevel } from "@/lib/orgs/access";

const tokens = new Map<string, InstallationToken>();

/** Installations' grants, asked again after this long: an owner accepting
 *  the App's new permissions is followed within it. */
const GRANTS_TTL_MS = 10 * 60 * 1000;
const grants = new Map<number, { permissions: Record<string, string>; at: number }>();

async function granted(config: GitHubAppConfig, installationId: number, fresh: boolean): Promise<Record<string, string>> {
  const kept = grants.get(installationId);
  if (!fresh && kept && Date.now() - kept.at < GRANTS_TTL_MS) return kept.permissions;
  const permissions = await installationPermissions(config, installationId);
  grants.set(installationId, { permissions, at: Date.now() });
  return permissions;
}

async function repoLevel(userId: string, orgId: string, repo: string): Promise<AccessLevel | null> {
  const project = (await listOrgProjects(orgId)).find((p) => p.fullName.toLowerCase() === repo.toLowerCase());
  return project ? projectLevel(userId, project.id) : null;
}

/** Whether users ever connected their own GitHub, kept a minute: a box's
 *  git asks for every fetch and push, and that rarely changes. */
const CONNECTED_TTL_MS = 60 * 1000;
const connected = new Map<string, { value: boolean; at: number }>();

/** Whether the user ever connected their own GitHub; true (not kept) when
 *  that can't be read, so the App is never taken for their own by mistake. */
async function ownConnected(userId: string): Promise<boolean> {
  const kept = connected.get(userId);
  if (kept && Date.now() - kept.at < CONNECTED_TTL_MS) return kept.value;
  try {
    const value = await personalConnected(userId);
    connected.set(userId, { value, at: Date.now() });
    return value;
  } catch (error) {
    console.error(`Could not read whether user ${userId} connected GitHub; assuming they did`, error);
    return true;
  }
}

const deps: IdentityDeps = {
  identity: getGithubIdentity,
  personalToken: personalCredential,
  personalConnected: ownConnected,
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
  level?: TokenLevel;
  identity?: GitHubIdentity;
}): Promise<GitCredential> {
  return resolveGitCredential(input, deps);
}

/** How an automation's review session works on GitHub, whatever its runner
 *  chose for their own: as the App, reading code and commenting. */
export const REVIEW_AS_APP = { identity: "app", level: "review" } as const;

/** Record a session as an automation's review, as the App (review_sessions:
 *  the server's alone, so its owner can't mark or unmark one). */
export async function markReviewSession(workspaceId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("review_sessions")
    .upsert({ workspace_id: workspaceId }, { onConflict: "workspace_id", ignoreDuplicates: true });
  if (error) throw error;
}

/** Whether a session reviews as the App (markReviewSession). */
export async function isReviewSession(workspaceId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("review_sessions")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** How a session's box works on GitHub: as an automation's review, as the
 *  App (REVIEW_AS_APP), else as its user chose (undefined). For the tokens
 *  the server fetches a session's mirrors with, as its box's own requests. */
export async function sessionGitAs(workspaceId: string): Promise<typeof REVIEW_AS_APP | undefined> {
  return (await isReviewSession(workspaceId)) ? REVIEW_AS_APP : undefined;
}

/** The token alone, for a server call that must have one; as the user chose,
 *  or as `as` says (REVIEW_AS_APP). */
export async function requireGitToken(
  userId: string,
  project: { orgId: string; fullName: string },
  as?: { identity: GitHubIdentity; level: TokenLevel },
): Promise<string> {
  return (await gitCredentialFor({ userId, orgId: project.orgId, repo: project.fullName, ...as })).token;
}

/**
 * The token, or undefined when there's none to be had (said in the log): for
 * a server call that can do without, such as fetching a mirror the box
 * already has, or a public repository.
 */
export async function optionalGitToken(
  userId: string,
  project: { orgId: string; fullName: string },
  as?: { identity: GitHubIdentity; level: TokenLevel },
): Promise<string | undefined> {
  try {
    return await requireGitToken(userId, project, as);
  } catch (error) {
    if (!(error instanceof MissingGithubTokenError)) {
      console.warn(`No GitHub token for ${project.fullName}`, error instanceof Error ? error.message : error);
    }
    return undefined;
  }
}

/** A token for each repository of a session of several, as asked. */
export function gitTokensFor(
  userId: string,
  orgId: string,
  as?: { identity: GitHubIdentity; level: TokenLevel },
): (fullName: string) => Promise<string | undefined> {
  return (fullName) => optionalGitToken(userId, { orgId, fullName }, as);
}
