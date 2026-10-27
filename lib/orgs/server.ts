import { cookies } from "next/headers";
import { cache } from "react";

import { listMyOrgs } from "@/lib/db/orgs";
import { ACTIVE_ORG_COOKIE, type Org, pickActiveOrg } from "@/lib/orgs/active";

export type OrgContext = {
  /** Every org the signed-in user is a member of, personal first. */
  orgs: Org[];
  /** The one the app is showing (lib/orgs/active.ts). */
  active: Org;
};

/**
 * The signed-in user's orgs and the active one, once per request (React
 * `cache`): the sidebar, the page and the route all ask. Null for a user in
 * no org, which every user is (a personal org is made with the account), or
 * before the migration that adds orgs.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const orgs = await listMyOrgs().catch((error: unknown) => {
    console.error("Could not list the user's orgs", error);
    return [];
  });
  const active = pickActiveOrg(orgs, (await cookies()).get(ACTIVE_ORG_COOKIE)?.value);
  return active ? { orgs, active } : null;
});

/** The active org's id, or undefined when there's none to filter by. */
export async function activeOrgId(): Promise<string | undefined> {
  return (await getOrgContext())?.active.id;
}

/** Remember the org picked in the switcher, for a year. */
export async function setActiveOrg(orgId: string): Promise<void> {
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}
