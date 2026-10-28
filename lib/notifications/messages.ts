/**
 * What a notification says in an email, a digest and a Slack DM. Pure, so the
 * wording is unit-tested.
 */

import type { NotificationKind } from "@/lib/notifications/events";

export type SentNotification = {
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: string;
};

/** A short subject line's lead for each kind. */
const LEAD: Record<NotificationKind, string> = {
  turn_done: "Finished",
  needs_input: "Needs you",
  errored: "Errored",
  pr_opened: "Pull request opened",
  pr_merged: "Pull request merged",
};

const EMOJI: Record<NotificationKind, string> = {
  turn_done: ":white_check_mark:",
  needs_input: ":raised_hand:",
  errored: ":warning:",
  pr_opened: ":arrow_heading_up:",
  pr_merged: ":tada:",
};

const SETTINGS = "/settings/account";

function link(base: string, path: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

export function sessionLink(base: string, workspaceId: string): string {
  return link(base, `/workspaces/${workspaceId}`);
}

/** One notification as its own email. */
export function instantEmail(notification: SentNotification, base: string): { subject: string; text: string } {
  return {
    subject: `${LEAD[notification.kind]}: ${notification.title}`,
    text: [
      notification.title,
      "",
      notification.body,
      "",
      `Open the session: ${sessionLink(base, notification.workspaceId)}`,
      "",
      `You get these because email notifications are on. Change them: ${link(base, SETTINGS)}`,
    ].join("\n"),
  };
}

/** The day's notifications, by session, newest first, as one email. */
export function digestEmail(notifications: SentNotification[], base: string): { subject: string; text: string } {
  const bySession = new Map<string, SentNotification[]>();
  for (const n of [...notifications].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    bySession.set(n.workspaceId, [...(bySession.get(n.workspaceId) ?? []), n]);
  }
  const needsYou = notifications.filter((n) => n.kind === "needs_input" || n.kind === "errored").length;
  const sessions = bySession.size;
  const lines: string[] = [];
  for (const [workspaceId, items] of bySession) {
    lines.push(items[0].title);
    for (const item of items) lines.push(`  • ${item.body}`);
    lines.push(`  ${sessionLink(base, workspaceId)}`, "");
  }
  return {
    subject:
      `Your sessions today: ${sessions} with news` + (needsYou > 0 ? `, ${needsYou} waiting on you` : ""),
    text: [...lines, `You get this digest once a day. Change it: ${link(base, SETTINGS)}`].join("\n"),
  };
}

/** One notification as a Slack DM, in Slack's mrkdwn. */
export function slackMessage(notification: SentNotification, base: string): string {
  const title = notification.title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  const body = notification.body.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);
  return `${EMOJI[notification.kind]} *<${sessionLink(base, notification.workspaceId)}|${title}>*\n${body}`;
}
