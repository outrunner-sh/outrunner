/**
 * The emails an org sends, when the deployment can (lib/email/send.ts): an
 * invite to its invitee, and a request to join to its admins.
 */

import type { DomainOrg } from "@/lib/db/orgs";
import { orgAdmins } from "@/lib/db/org-members";
import { sendEmail } from "@/lib/email/send";
import { optionalEnv } from "@/lib/env";

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
  return sendEmail({
    to: [input.to],
    subject: `${input.inviter} invited you to ${input.orgName} on Outrunner`,
    text: [
      `${input.inviter} invited you to join ${input.orgName} on Outrunner.`,
      "",
      `Accept it here, signing in with GitHub: ${input.link}`,
      "",
      "Sign in with a GitHub account that has this email address verified. The link works for 7 days.",
    ].join("\n"),
  });
}

/** Tell an org's admins that `email` asked to join it. */
export async function emailJoinRequest(org: DomainOrg, email: string): Promise<void> {
  const admins = (await orgAdmins(org.id)).flatMap((a) => (a.email ? [a.email] : []));
  await sendEmail({
    to: admins,
    subject: `${email} asked to join ${org.name} on Outrunner`,
    text: [
      `${email} signed in to Outrunner and asked to join ${org.name}, whose domain (${org.domain}) their email is on.`,
      "",
      `Approve or decline it under Settings → Org → Members: ${appUrl("/settings/org/members")}`,
      "",
      "They can't use Outrunner in your org until an admin approves them.",
    ].join("\n"),
  });
}
