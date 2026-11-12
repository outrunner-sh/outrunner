/**
 * Saved Slack events' real wiring (lib/missions/slack-inbound.ts):
 * mission_slack_inbound and its lease functions with the service role, and
 * the Slack agent to handle them.
 */

import { channelBinding, channelThread } from "@/lib/missions/slack-store";
import { type InboundDeps, MAX_INBOUND_ATTEMPTS, processInbound } from "@/lib/missions/slack-inbound";
import type { AgentMessage } from "@/lib/slack/agent-run";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A processor's lease: long enough to route a message. */
const LEASE_SECONDS = 120;

function db() {
  return createSupabaseAdminClient();
}

export function inboundDeps(): InboundDeps {
  return {
    // Unlike the Slack agent's own read, a failure here is thrown: the
    // endpoint answers so that Slack sends the event again.
    binding: channelBinding,
    thread: channelThread,
    save: async (eventId, message) => {
      const { data, error } = await db()
        .from("mission_slack_inbound")
        .upsert(
          { event_id: eventId, team_id: message.teamId, channel_id: message.channel, message: message as unknown as Json },
          { onConflict: "event_id", ignoreDuplicates: true },
        )
        .select("event_id");
      if (error && (error.code === "42P01" || error.code === "PGRST205")) return "unavailable";
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
    claim: async (eventId) => {
      const { data, error } = await db().rpc("claim_mission_slack_inbound", { target: eventId, lease_seconds: LEASE_SECONDS });
      if (error) throw error;
      const row = data?.[0];
      return row ? { message: row.message as unknown as AgentMessage, attempt: row.attempt } : null;
    },
    handle: async (message, options) => {
      const { handleAgentMessage } = await import("@/lib/slack/agent-run");
      await handleAgentMessage(message, options);
    },
    complete: async (eventId, attempt) => {
      const { error } = await db().rpc("complete_mission_slack_inbound", { target: eventId, attempt });
      if (error) throw error;
    },
    fail: async (eventId, attempt, reason) => {
      console.warn(`Slack: event ${eventId} for a Mission wasn't processed (try ${attempt}): ${reason}`);
      const { error } = await db().rpc("fail_mission_slack_inbound", { target: eventId, attempt, failure: reason, max_attempts: MAX_INBOUND_ATTEMPTS });
      if (error) throw error;
    },
  };
}

/** Process a saved event now; never throws. */
export async function processInboundNow(eventId: string): Promise<void> {
  await processInbound(eventId, inboundDeps()).catch((error: unknown) => console.error(`Slack: event ${eventId} couldn't be processed`, error));
}

/** The tick's part: saved events never processed, or whose processor died
 *  (older than a minute, so the one right after the answer goes first), and
 *  old processed ones pruned. */
export async function processDueInbound(max = 25): Promise<number> {
  const { data, error } = await db().rpc("due_mission_slack_inbound", { max_events: max, grace_seconds: 60 });
  if (error) throw error;
  let done = 0;
  for (const row of data ?? []) {
    if ((await processInbound(row.event_id, inboundDeps()).catch(() => "retry")) === "done") done++;
  }
  await db()
    .from("mission_slack_inbound")
    .delete()
    .eq("status", "done")
    .lt("processed_at", new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString())
    .then(
      () => undefined,
      () => undefined,
    );
  return done;
}
