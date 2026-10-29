/**
 * A Slack thread and its session, the parts with no network: what the session
 * is told a thread message is, when a turn is over, and how its reply is
 * posted (lib/slack/relay.ts runs them).
 */

import { markdownToSlack, slackChunks } from "@/lib/slack/research-text";

// When a turn is over is the shared turn watcher's (lib/session/turn-watch.ts).
export { QUIET_MS, turnOver } from "@/lib/session/turn-watch";

/** A thread message as the session gets it: who said it, from where. */
export function fromThread(name: string, text: string): string {
  return `${name} (in the Slack thread): ${text}`;
}

/** Reply text for the thread: Slack's markup, a link to the whole session. */
export function replyChunks(message: string, url: string): string[] {
  const chunks = slackChunks(markdownToSlack(message.trim()), 3500);
  if (chunks.length) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n<${url}|Open the session>`;
  return chunks;
}
