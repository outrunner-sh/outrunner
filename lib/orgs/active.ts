/**
 * The org the app is showing: the one the user last picked in the sidebar's
 * switcher (a cookie), while they're still a member of it, else their
 * personal org. Projects and sessions are listed for it, and a repository
 * connected goes into it.
 */

/** Read by the app layout for the frame, as the sidebar's own cookies are
 *  (lib/nav/sidebar.ts): named again in each instant page's
 *  `unstable_instant` samples, which static analysis reads. */
export const ACTIVE_ORG_COOKIE = "outrunner_org";

export type OrgRole = "admin" | "member";

/** Whose view a page showed: the signed-in user in the org the app shows.
 *  What a page keeps for its next visit is kept under it
 *  (lib/client/kept-page.ts), and shown only to the same view again. */
export function viewerScope(userId: string, orgId: string): string {
  return `${userId}:${orgId}`;
}

export type Org = {
  id: string;
  name: string;
  /** The user's own org, made with their account: there's one each. */
  personal: boolean;
  /** The signed-in user's role in it. */
  role: OrgRole;
};

/** The line under an org's name in the switcher: whose it is, and the
 *  user's part in a team's. */
export function orgSummary(org: Pick<Org, "personal" | "role">): string {
  if (org.personal) return "Personal";
  return org.role === "admin" ? "Team · Admin" : "Team · Member";
}

/** The personal org first, then team orgs by name. */
export function sortOrgs(orgs: readonly Org[]): Org[] {
  return [...orgs].sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
}

/**
 * The org to show: the cookie's, when the user is a member of it, else their
 * personal org, else (never expected: every user has one) the first. Null
 * only for a user in no org at all.
 */
export function pickActiveOrg(orgs: readonly Org[], wanted: string | undefined): Org | null {
  return orgs.find((o) => o.id === wanted) ?? orgs.find((o) => o.personal) ?? orgs[0] ?? null;
}

/**
 * The ids of the orgs among a user's memberships that someone else made. An
 * org whose maker has since gone (`createdBy` null) is someone else's too.
 */
export function madeByOthers(memberships: readonly { orgId: string; createdBy: string | null }[], userId: string): string[] {
  return memberships.filter((m) => m.createdBy !== userId).map((m) => m.orgId);
}

/** An org's name, as a user may give it: trimmed, 1 to 80 characters. */
export function orgName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
}
