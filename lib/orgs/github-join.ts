/**
 * Joining a team org as a member of its GitHub organization
 * (20261119100000_github_org_join.sql): an org whose GitHub App installation
 * is on a GitHub organization, as that installation's source org, lets that
 * organization's active members in at once, as members, unless its admins
 * turned it off. "New team org" lists the ones it finds for the signed-in
 * user, and joins one (app/api/orgs/github-matches, app/api/orgs/[id]/join-via-github).
 *
 * Finding them is costly, so it's only asked for there, never on a page load:
 * the user's own GitHub App user token lists the installations they reach
 * (one call); only those that are some team org's source, and whose org they
 * aren't in, are checked with GitHub, as each installation (its token, and
 * the App's Members: Read), MEMBERSHIP_CHECKS_AT_ONCE at a time.
 *
 * It fails closed: a membership GitHub won't confirm (the installation hasn't
 * granted Members: Read, a 404, an outage) is no way in, and the person is
 * told to ask an admin for an invite. Joining asks GitHub again, for the one
 * org, on the server: the list is never taken on trust.
 *
 * Its collaborators are passed in (github-join.deps.ts wires them), so it
 * tests without a database or GitHub.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
import type { UserInstallation } from "@/lib/github/user-auth";

/** How many installations' memberships are asked of GitHub at once. */
export const MEMBERSHIP_CHECKS_AT_ONCE = 4;

/** A GitHub user, as their own token says: their id, and their login now. */
export type GitHubUser = { id: number; login: string };

/** A team org that is an installation's source, still connected to it, on a
 *  GitHub organization (not a user account), not suspended. */
export type SourceOrg = {
  orgId: string;
  orgName: string;
  installationId: number;
  /** The GitHub organization's login, as Outrunner keeps it. */
  githubOrg: string;
  /** Its admins' setting (organization_settings.join_via_github). */
  joinViaGithub: boolean;
};

/** Why a match can't be joined: GitHub didn't confirm the membership, the
 *  org's admins turned this off, or one of them removed the user. */
export type GitHubJoinWhy = "unverified" | "disabled" | "removed";

export type GitHubJoinMatch = {
  orgId: string;
  orgName: string;
  githubOrg: string;
  installationId: number;
  canJoin: boolean;
  why?: GitHubJoinWhy;
};

export type GitHubJoinMatches = {
  matches: GitHubJoinMatch[];
  /** Whether the user has a GitHub connection to look with: without one,
   *  "Connect GitHub" is what finds their team. */
  githubConnected: boolean;
};

export type GitHubJoinDeps = {
  /** The user's GitHub App user token; null when they haven't connected
   *  GitHub, or must connect it again. */
  userToken(userId: string): Promise<string | null>;
  /** Who the token is. */
  githubUser(token: string): Promise<GitHubUser>;
  /** The App's installations the token reaches. */
  installations(token: string): Promise<UserInstallation[]>;
  /** The team orgs that are source orgs of these installations. */
  sourceOrgsOf(installationIds: readonly number[]): Promise<SourceOrg[]>;
  /** The source installations of one org. */
  sourceInstallationsOf(orgId: string): Promise<SourceOrg[]>;
  /** The orgs the user is in, and those an admin removed them from. */
  standing(userId: string): Promise<{ memberOf: ReadonlySet<string>; removedFrom: ReadonlySet<string> }>;
  /** Whether GitHub says `user` is an active member of `githubOrg`, asked as
   *  installation `installationId`. */
  activeMember(installationId: number, githubOrg: string, user: GitHubUser): Promise<boolean>;
};

/** GitHub's answer, with no answer (it threw) taken as no. */
async function confirmed(deps: GitHubJoinDeps, source: SourceOrg, user: GitHubUser): Promise<boolean> {
  try {
    return await deps.activeMember(source.installationId, source.githubOrg, user);
  } catch {
    return false;
  }
}

const byName = (a: SourceOrg, b: SourceOrg) =>
  a.orgName.localeCompare(b.orgName) || a.githubOrg.localeCompare(b.githubOrg) || a.orgId.localeCompare(b.orgId);

/**
 * The team orgs `userId` could join through their GitHub organizations, by
 * name: one each, joinable where GitHub confirmed them through any of its
 * GitHub organizations.
 */
export async function githubJoinMatches(userId: string, deps: GitHubJoinDeps): Promise<GitHubJoinMatches> {
  const token = await deps.userToken(userId);
  if (!token) return { matches: [], githubConnected: false };

  const [user, installations] = await Promise.all([deps.githubUser(token), deps.installations(token)]);
  // A user account's installation lets no one into anything; a suspended
  // one can't ask GitHub.
  const reached = installations.filter((i) => i.accountType === "Organization" && i.suspendedAt === null).map((i) => i.id);
  if (reached.length === 0) return { matches: [], githubConnected: true };

  const [sources, standing] = await Promise.all([deps.sourceOrgsOf(reached), deps.standing(userId)]);
  const reachedIds = new Set(reached);
  const candidates = sources
    .filter((s) => reachedIds.has(s.installationId) && !standing.memberOf.has(s.orgId))
    .sort(byName);

  // Only ask GitHub where the answer could let them in.
  const blocked = (s: SourceOrg): GitHubJoinWhy | null =>
    !s.joinViaGithub ? "disabled" : standing.removedFrom.has(s.orgId) ? "removed" : null;
  const asked = candidates.filter((s) => blocked(s) === null);
  const answers = await mapWithConcurrency(asked, MEMBERSHIP_CHECKS_AT_ONCE, (s) => confirmed(deps, s, user));
  const verified = new Set(asked.filter((_, i) => answers[i]));

  // One match an org: its first confirmed GitHub organization, else its first.
  const matches = new Map<string, GitHubJoinMatch>();
  for (const s of candidates) {
    const why = blocked(s) ?? (verified.has(s) ? null : "unverified");
    const match: GitHubJoinMatch = {
      orgId: s.orgId,
      orgName: s.orgName,
      githubOrg: s.githubOrg,
      installationId: s.installationId,
      canJoin: why === null,
      ...(why && { why }),
    };
    const kept = matches.get(s.orgId);
    if (!kept || (!kept.canJoin && match.canJoin)) matches.set(s.orgId, match);
  }
  return { matches: [...matches.values()], githubConnected: true };
}

/** Why joining an org through GitHub was refused before the database was
 *  asked: no GitHub connection, or GitHub confirmed no membership of any of
 *  the org's GitHub organizations (or the org has none). */
export type GitHubJoinCheck =
  | { ok: true; githubOrg: string; installationId: number }
  | { ok: false; reason: "not_connected" | "unverified" };

/**
 * Check, with GitHub, that `userId` may join `orgId` through one of its
 * GitHub organizations, for the database to let them in
 * (join_org_via_github, which checks the rest). Asked afresh for every join:
 * whatever the browser says is not taken.
 */
export async function verifyGithubJoin(userId: string, orgId: string, deps: GitHubJoinDeps): Promise<GitHubJoinCheck> {
  const token = await deps.userToken(userId);
  if (!token) return { ok: false, reason: "not_connected" };
  const [user, sources] = await Promise.all([deps.githubUser(token), deps.sourceInstallationsOf(orgId)]);
  for (const source of [...sources].sort(byName)) {
    if (await confirmed(deps, source, user)) {
      return { ok: true, githubOrg: source.githubOrg, installationId: source.installationId };
    }
  }
  return { ok: false, reason: "unverified" };
}
