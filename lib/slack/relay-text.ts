/**
 * A Slack thread and its session, the parts with no network: what the session
 * is told a thread message is, when a turn is over, and how its reply is
 * posted (lib/slack/relay.ts runs them).
 */

import { markdownToSlack, slackChunks } from "@/lib/slack/research-text";

/** Quiet this long after its last activity, a session's turn is over. */
export const QUIET_MS = 20_000;

/** A thread message as the session gets it: who said it, from where. */
export function fromThread(name: string, text: string): string {
  return `${name} (in the Slack thread): ${text}`;
}

/**
 * Whether the reply to what was sent at `since` is over: there's a reply, the
 * session was active after the send (so it's this turn's, not an older one a
 * slow wake left showing), and it has gone quiet.
 */
export function turnOver(
  summary: { lastAssistantMessage: string | null; lastActivity: string },
  since = 0,
  now = Date.now(),
): boolean {
  if (!summary.lastAssistantMessage?.trim()) return false;
  const last = Date.parse(summary.lastActivity);
  return Number.isFinite(last) && last > since && now - last >= QUIET_MS;
}

/** Reply text for the thread: Slack's markup, a link to the whole session. */
export function replyChunks(message: string, url: string): string[] {
  const chunks = slackChunks(markdownToSlack(message.trim()), 3500);
  if (chunks.length) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n<${url}|Open the session>`;
  return chunks;
}
