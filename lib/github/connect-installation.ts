/**
 * Connecting a GitHub App installation to an org, past the link itself
 * (claimInstallation): where GitHub's return without our signed state goes.
 * Apart from Next and the database, so the rule tests on its own (wired in
 * app/api/github/app/setup/route.ts).
 */

import type { OrgRole } from "@/lib/orgs/active";

/**
 * GitHub back without our state: from "Redirect on update" after someone
 * changed the App's repositories on GitHub, or an install begun there.
 *
 * - `refresh`: one the org they're looking at (else their own org) has
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
  ownOrgId: string | null;
}): ReturnWithoutState {
  const { linkedOrgIds, activeOrg, ownOrgId } = input;
  if (!linkedOrgIds) return { kind: "expired" };
  if (activeOrg && linkedOrgIds.includes(activeOrg.id)) return { kind: "refresh", orgId: activeOrg.id };
  if (ownOrgId && linkedOrgIds.includes(ownOrgId)) return { kind: "refresh", orgId: ownOrgId };
  if (!activeOrg) return { kind: "expired" };
  if (activeOrg.role !== "admin") return { kind: "not_admin" };
  return { kind: "offer", orgId: activeOrg.id };
}
