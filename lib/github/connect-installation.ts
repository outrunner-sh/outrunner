/**
 * Connecting a GitHub App installation to an org, past the link itself
 * (claimInstallation): where GitHub's return without our signed state goes,
 * and the org's projects made from what it reaches. Apart from Next and the
 * database, so the rules test on their own (wired in
 * app/api/github/app/setup/route.ts and app/api/orgs/[id]/github/installations).
 */

import type { GitHubRepository } from "@/lib/github/client";
import type { OrgRole } from "@/lib/orgs/active";

/**
 * GitHub back without our state: from "Redirect on update" after someone
 * changed the App's repositories on GitHub, or an install begun there.
 *
 * - `refresh`: one the org they're looking at (else their personal org) has
 *   already: kept up to date.
 * - `offer`: one the org they're looking at, which they administer, hasn't:
 *   offered for them to add there with a click. Never linked on this GET
 *   alone (anyone can send them to it); the click checks GitHub's say as
 *   adding one always does.
 * - `not_admin`, `expired`: neither; said as before.
 */
export type ReturnWithoutState =
  | { kind: "refresh"; orgId: string }
  | { kind: "offer"; orgId: string }
  | { kind: "not_admin" }
  | { kind: "expired" };

export function returnWithoutState(input: {
  /** The orgs it's linked to; null when Outrunner hasn't heard of it. */
  linkedOrgIds: readonly string[] | null;
  activeOrg: { id: string; role: OrgRole } | null;
  personalOrgId: string | null;
}): ReturnWithoutState {
  const { linkedOrgIds, activeOrg, personalOrgId } = input;
  if (!linkedOrgIds) return { kind: "expired" };
  if (activeOrg && linkedOrgIds.includes(activeOrg.id)) return { kind: "refresh", orgId: activeOrg.id };
  if (personalOrgId && linkedOrgIds.includes(personalOrgId)) return { kind: "refresh", orgId: personalOrgId };
  if (!activeOrg) return { kind: "expired" };
  if (activeOrg.role !== "admin") return { kind: "not_admin" };
  return { kind: "offer", orgId: activeOrg.id };
}

export type SyncInstallationDeps = {
  /** Every repository the installation reaches. */
  list(installationId: number): Promise<GitHubRepository[]>;
  /** Saves them as the org's projects, connected by `ownerId`; how many. */
  upsert(ownerId: string, repositories: GitHubRepository[], orgId: string): Promise<number>;
};

/**
 * Just connected to an org: the repositories the installation reaches become
 * its projects, as "Sync repositories" would make them, so the org has them
 * at once. Only this installation's: an org that has picked its projects
 * from another isn't handed every repository of that one too. Best effort:
 * null when they couldn't be listed or saved. The connection stands, and
 * Sync repositories tries again.
 */
export async function syncInstallationProjects(
  input: { ownerId: string; orgId: string; installationId: number },
  deps: SyncInstallationDeps,
): Promise<number | null> {
  try {
    const repositories = await deps.list(input.installationId);
    return repositories.length > 0 ? await deps.upsert(input.ownerId, repositories, input.orgId) : 0;
  } catch (error) {
    console.error(`Couldn't add installation ${input.installationId}'s repositories to org ${input.orgId}`, error);
    return null;
  }
}
