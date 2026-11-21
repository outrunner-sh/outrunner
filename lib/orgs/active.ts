/**
 * The org the app is showing: the one the user last picked in the sidebar's
 * switcher (a cookie), while they're still a member of it, else the one
 * they joined first. Projects and sessions are listed for it, and a repository
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
  /** When the signed-in user joined it (made it, for their own). */
  joinedAt: string;
  /** The signed-in user's role in it. */
  role: OrgRole;
};

/** The line under an org's name in the switcher: the user's part in it. */
export function orgSummary(org: Pick<Org, "role">): string {
  return org.role === "admin" ? "Admin" : "Member";
}

/** Orgs by name; two alike, by id, so the order never shifts. */
export function sortOrgs(orgs: readonly Org[]): Org[] {
  return [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The org to show: the cookie's, when the user is a member of it, else the
 * one they joined first (firstJoined), as a call naming no org acts in. Null
 * only for a user in no org at all.
 */
export function pickActiveOrg(orgs: readonly Org[], wanted: string | undefined): Org | null {
  const first = firstJoined(orgs.map((o) => ({ orgId: o.id, joinedAt: o.joinedAt })));
  return orgs.find((o) => o.id === wanted) ?? orgs.find((o) => o.id === first) ?? null;
}

/**
 * The ids of the orgs among a user's memberships that someone else made. An
 * org whose maker has since gone (`createdBy` null) is someone else's too.
 */
export function madeByOthers(memberships: readonly { orgId: string; createdBy: string | null }[], userId: string): string[] {
  return memberships.filter((m) => m.createdBy !== userId).map((m) => m.orgId);
}

/**
 * The org a call that names none acts in (the CLI, a personal API key): the
 * one the user joined first, so the same command always lands in the same
 * place: for most, their own org, made when they first signed in. Ties, by
 * id. Null for no membership.
 */
export function firstJoined(memberships: readonly { orgId: string; joinedAt: string }[]): string | null {
  const [first] = [...memberships].sort(
    (a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.orgId.localeCompare(b.orgId),
  );
  return first?.orgId ?? null;
}

/** An org's name, as a user may give it: trimmed, 1 to 80 characters. */
export function orgName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
}
