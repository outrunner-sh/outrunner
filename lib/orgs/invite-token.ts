/**
 * An invite link's lifetime and token, for making an invite
 * (lib/db/org-members.ts) and resending one (lib/orgs/invite-resend.ts).
 */

import { randomSecret } from "@/lib/auth/cli-login";

/** How long an invite link works. */
export const INVITE_DAYS = 7;

/** A new invite link's token. The prefix says what it is wherever one turns
 *  up; only its hash (hashSecret) is kept. */
export function newInviteToken(): string {
  return `or_inv_${randomSecret()}`;
}
