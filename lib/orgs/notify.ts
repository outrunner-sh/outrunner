/**
 * The emails an org sends, when the deployment can (lib/email/send.ts): an
 * invite to its invitee, and a request to join to its admins.
 */

import type { DomainOrg } from "@/lib/db/orgs";
import { orgAdmins } from "@/lib/db/org-members";
import { sendEmail } from "@/lib/email/send";
import { optionalEnv } from "@/lib/env";
import { inviteMessage, joinRequestMessage } from "@/lib/orgs/emails";
import { INVITE_DAYS } from "@/lib/orgs/invite-token";

/** Where links in an email point: the deployment's own origin. */
export function appUrl(path: string, requestOrigin?: string): string {
  const base = optionalEnv("RUNTIME_BASE_URL") ?? requestOrigin ?? "";
  return `${base.replace(/\/$/, "")}${path}`;
}

/** The link an invite's token opens. */
export function inviteLink(token: string, requestOrigin?: string): string {
  return appUrl(`/invite/${encodeURIComponent(token)}`, requestOrigin);
}

/** Send an invite's link to its invitee; whether it went. */
export function emailInvite(input: { to: string; orgName: string; inviter: string; link: string }): Promise<boolean> {
  return sendEmail({ to: [input.to], ...inviteMessage({ ...input, days: INVITE_DAYS }) });
}

/** Tell an org's admins that `email` asked to join it. `origin`: the
 *  deployment's, for the link when RUNTIME_BASE_URL isn't set. */
export async function emailJoinRequest(org: DomainOrg, email: string, origin?: string): Promise<void> {
  const admins = (await orgAdmins(org.id)).flatMap((a) => (a.email ? [a.email] : []));
  await sendEmail({
    to: admins,
    ...joinRequestMessage({
      orgName: org.name,
      domain: org.domain,
      email,
      link: appUrl("/settings/org/members", origin),
    }),
  });
}
