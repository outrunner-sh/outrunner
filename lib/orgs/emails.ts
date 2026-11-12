/**
 * What an org's emails say (lib/orgs/notify.ts sends them): each as plain
 * text and as HTML (lib/email/html.ts), which escapes the names and emails
 * in it. Pure, for the tests.
 */

import { emailHtml } from "@/lib/email/html";

export type Message = { subject: string; text: string; html: string };

/** The invite an invitee is sent: who invited them to what, and its link. */
export function inviteMessage(input: { orgName: string; inviter: string; link: string; days: number }): Message {
  const { orgName, inviter, link, days } = input;
  const caveat = `Sign in with a GitHub account that has this email address verified. The link works for ${days} days.`;
  return {
    subject: `${inviter} invited you to ${orgName} on Outrunner`,
    text: [
      `${inviter} invited you to join ${orgName} on Outrunner.`,
      "",
      `Accept it here, signing in with GitHub: ${link}`,
      "",
      caveat,
    ].join("\n"),
    html: emailHtml({
      preheader: `Join ${orgName} on Outrunner.`,
      heading: `Join ${orgName} on Outrunner`,
      body: [`${inviter} invited you to join ${orgName} on Outrunner.`, "Accept the invite by signing in with GitHub."],
      action: { label: "Accept invite", url: link },
      footer: [caveat, "If you weren't expecting this, you can ignore this email."],
    }),
  };
}

/** What an org's admins are sent when `email` asks to join it. */
export function joinRequestMessage(input: { orgName: string; domain: string; email: string; link: string }): Message {
  const { orgName, domain, email, link } = input;
  const asked = `${email} signed in to Outrunner and asked to join ${orgName}, whose domain (${domain}) their email is on.`;
  const caveat = "They can't use Outrunner in your org until an admin approves them.";
  return {
    subject: `${email} asked to join ${orgName} on Outrunner`,
    text: [asked, "", `Approve or decline it under Settings → Org → Members: ${link}`, "", caveat].join("\n"),
    html: emailHtml({
      preheader: `${email} asked to join ${orgName}.`,
      heading: `${email} asked to join ${orgName}`,
      body: [asked, "Approve or decline it under Settings → Org → Members."],
      action: { label: "Review request", url: link },
      footer: [caveat],
    }),
  };
}
