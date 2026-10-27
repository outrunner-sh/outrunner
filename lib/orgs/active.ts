/**
 * The org the app is showing: the one the user last picked in the sidebar's
 * switcher (a cookie), while they're still a member of it, else their
 * personal org. Projects and sessions are listed for it, and a repository
 * connected goes into it.
 */

export const ACTIVE_ORG_COOKIE = "outrunner_org";

export type OrgRole = "admin" | "member";

export type Org = {
  id: string;
  name: string;
  /** The user's own org, made with their account: there's one each. */
  personal: boolean;
  /** The signed-in user's role in it. */
  role: OrgRole;
};

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

/** An org's name, as a user may give it: trimmed, 1 to 80 characters. */
export function orgName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
}
