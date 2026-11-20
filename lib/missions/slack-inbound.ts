/**
 * Slack's events for a Mission on call, saved before Slack is answered
 * (docs/missions.md, "Reliability"). The events endpoint
 * (app/api/integrations/slack/events) asks `acceptInbound` first:
 *
 *   - a message a Mission may take (a mention in a channel with a Mission on
 *     call, or a reply in a thread a Mission took) is saved, keyed by its
 *     Slack event id, before the endpoint answers 200. One saved before (a
 *     retry of the event) is answered the same, and saved once;
 *   - if it can't be saved, or it can't be told whether it's a Mission's (the
 *     database is down), the endpoint answers 503, and Slack sends it again;
 *   - anything else goes the Slack agent's way as before
 *     (firstSighting, then the agent after the answer).
 *
 * Saved events are processed under a lease (`processInbound`): right after
 * the answer, and by the tick for any that never were (a crash between the
 * two), or whose processor died. A failure is tried again with backoff; the
 * last try says sorry in the thread, as an unsaved one would.
 *
 * Duplicates between a mention's `message` and `app_mention` events are left
 * to the Slack agent (lib/slack/agent-run.ts), which answers the
 * app_mention and drops the message copy, saved or not.
 */

import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import type { AgentMessage } from "@/lib/slack/agent-run";

/** Tries before an event is given up. */
export const MAX_INBOUND_ATTEMPTS = 8;

export type InboundDeps = {
  binding(teamId: string, channelId: string): Promise<MissionChannel | null>;
  thread(teamId: string, channelId: string, threadTs: string): Promise<MissionThread | null>;
  /** Save it under its event id; false when it was saved before;
   *  "unavailable" when there's nowhere to save it (the migration that adds
   *  the table isn't applied yet). */
  save(eventId: string, message: AgentMessage): Promise<boolean | "unavailable">;
  claim(eventId: string): Promise<{ message: AgentMessage; attempt: number } | null>;
  /** Handle it as the Slack agent does; throws when it should be tried again. */
  handle(message: AgentMessage, options: { retryable: true; final: boolean }): Promise<void>;
  complete(eventId: string, attempt: number): Promise<void>;
  fail(eventId: string, attempt: number, reason: string): Promise<void>;
};

/** Whether a Mission may take the message: a mention, or a reply in a
 *  thread it took, in a channel with a Mission on call. */
export async function missionEligible(message: AgentMessage, deps: Pick<InboundDeps, "binding" | "thread">): Promise<boolean> {
  if (message.channelType === "im" || !/^[CG]/.test(message.channel)) return false;
  if (!message.mention && !message.threadTs) return false;
  const binding = await deps.binding(message.teamId, message.channel);
  if (!binding) return false;
  if (message.mention) return true;
  const thread = await deps.thread(message.teamId, message.channel, message.threadTs as string);
  return thread !== null && thread.missionId === binding.missionId;
}

/** What the endpoint does with an event: saved (or saved before) for a
 *  Mission, or the Slack agent's as before. Throws when it can't tell, or
 *  can't save: the endpoint answers so that Slack retries. */
export async function acceptInbound(eventId: string, message: AgentMessage, deps: InboundDeps): Promise<"saved" | "duplicate" | "not_mission"> {
  if (!(await missionEligible(message, deps))) return "not_mission";
  const saved = await deps.save(eventId, message);
  // Before the migration: handled as before, unsaved, rather than refused.
  if (saved === "unavailable") return "not_mission";
  return saved ? "saved" : "duplicate";
}

/** Process a saved event, if it's due and no one else holds it. */
export async function processInbound(eventId: string, deps: InboundDeps): Promise<"done" | "retry" | "busy"> {
  const claim = await deps.claim(eventId);
  if (!claim) return "busy";
  try {
    await deps.handle(claim.message, { retryable: true, final: claim.attempt >= MAX_INBOUND_ATTEMPTS });
  } catch (error) {
    await deps.fail(eventId, claim.attempt, error instanceof Error ? error.message : String(error));
    return "retry";
  }
  await deps.complete(eventId, claim.attempt);
  return "done";
}
