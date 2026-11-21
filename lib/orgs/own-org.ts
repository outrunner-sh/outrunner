/**
 * A user's own org: an ordinary org, made the first time they're in the app
 * and in no org (20261120130000_own_org_on_sign_in.sql), named after them.
 * Anyone can be invited into it straight away. Made at sign-in
 * (lib/auth/complete-sign-in.ts), unless they're on their way to accept an
 * invite; and, should that not have happened, by the first page that finds
 * them in none (lib/orgs/server.ts). The rules are here, apart from the
 * database, so they test on their own.
 */

import { isInvitePath } from "@/lib/orgs/admission";

/** The longest a first name goes into an org's name: it stays within 80. */
const FIRST_NAME_MAX = 60;

/**
 * "<First name>'s organization", from the name the app shows for them
 * (ownerFromUser: their full name, else their login, else their email); "My
 * organization" when there's nothing to go by.
 */
export function ownOrgName(displayName: string): string {
  const name = displayName.trim();
  // An email: its local part, as far as any "+tag".
  const first = (name.includes("@") ? name.split("@")[0].split("+")[0] : name.split(/\s+/)[0]).slice(0, FIRST_NAME_MAX);
  return first ? `${first}'s organization` : "My organization";
}

/** Whether sign-in should make the user's own org now: not on their way to
 *  an invite, whose org they'll be in once they accept it. */
export function ownOrgOnSignIn(next: string): boolean {
  return !isInvitePath(next);
}

/**
 * Which of the orgs a user made and administers is their own: their personal
 * org while they have one, else the first they made. Ties, by id.
 */
export function pickOwnOrg(made: readonly { id: string; personal: boolean; createdAt: string }[]): string | null {
  const [own] = [...made].sort(
    (a, b) =>
      Number(b.personal) - Number(a.personal) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return own?.id ?? null;
}
