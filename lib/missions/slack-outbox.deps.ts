/**
 * The Slack post queue's real wiring (lib/missions/slack-outbox.ts):
 * mission_slack_posts with the service role, claimed under a lease
 * (claim_mission_slack_posts), and Slack through the installation's bot.
 * Queueing a post also sends it right after the response; the tick sends
 * whatever that missed, or whose sender died.
 */

import { after } from "next/server";

import { getInstallation } from "@/lib/db/slack-agent";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { missionBinding, setAskMessage, threadMuted } from "@/lib/missions/slack-store";
import {
  type ClaimedPost,
  deliverPost,
  type OutboxPostDeps,
  type PostOutcome,
  type PostPayload,
  type QueueOutcome,
  type QueuedPost,
} from "@/lib/missions/slack-outbox";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import type { Json, MissionSlackPostRow } from "@/lib/supabase/database.types";
import { addReaction, postMessage, threadMarkers } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A sender's lease: long enough for a long reply's chunks. */
const LEASE_SECONDS = 120;

function db() {
  return createSupabaseAdminClient();
}

async function token(teamId: string): Promise<string> {
  const install = await getInstallation(teamId);
  if (!install) throw new Error(`Outrunner isn't installed in Slack workspace ${teamId} any more`);
  return install.botToken;
}

function toClaimed(row: MissionSlackPostRow): ClaimedPost {
  return {
    id: row.id,
    opKey: row.op_key,
    missionId: row.mission_id,
    bindingRevision: row.binding_revision,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    kind: row.kind,
    payload: row.payload as PostPayload,
    requester: row.requester,
    attempt: row.attempts,
    progress: row.progress,
    postedTs: row.posted_ts,
    inDoubt: row.in_doubt,
  };
}

export function postDeps(): OutboxPostDeps {
  return {
    binding: missionBinding,
    muted: threadMuted,
    mission: sessionById,
    canRead: async (userId, mission) => allows(await missionLevel(userId, mission), "read"),
    post: async (post, message) =>
      postMessage(await token(post.teamId), { channel: post.channelId, threadTs: post.threadTs, ...message }),
    react: async (post, ts, name) => addReaction(await token(post.teamId), { channel: post.channelId, ts, name }),
    markers: async (post) => threadMarkers(await token(post.teamId), post.channelId, post.threadTs),
    progressed: async (post, progress, postedTs) => {
      const { error } = await db()
        .from("mission_slack_posts")
        .update({ progress, posted_ts: postedTs, in_doubt: false })
        .eq("id", post.id)
        .eq("attempts", post.attempt)
        .eq("status", "pending");
      if (error) throw error;
    },
    askPosted: setAskMessage,
  };
}

/** Record what came of a send, under its own claim only. */
async function record(post: ClaimedPost, outcome: PostOutcome): Promise<void> {
  const patch =
    outcome.status === "retry"
      ? {
          lease_until: null,
          last_error: outcome.error.slice(0, 2000),
          in_doubt: outcome.inDoubt,
          progress: outcome.progress,
          posted_ts: outcome.postedTs,
          next_attempt_at: new Date(Date.now() + outcome.delaySeconds * 1000).toISOString(),
        }
      : outcome.status === "sent"
        ? { status: "sent" as const, lease_until: null, posted_ts: outcome.postedTs, progress: outcome.postedTs.length, in_doubt: false, finished_at: new Date().toISOString() }
        : {
            status: outcome.status,
            lease_until: null,
            last_error: outcome.error.slice(0, 2000),
            progress: outcome.progress,
            posted_ts: outcome.postedTs,
            finished_at: new Date().toISOString(),
          };
  const { error } = await db().from("mission_slack_posts").update(patch).eq("id", post.id).eq("attempts", post.attempt).eq("status", "pending");
  if (error) throw error;
  if (outcome.status === "ambiguous" || outcome.status === "failed") {
    console.warn(`Mission ${post.missionId}: Slack post ${post.opKey} ${outcome.status}: ${outcome.error}`);
  }
}

/** Send what's due now: one post (`target`), or any (the tick). How many
 *  were sent. */
export async function deliverPosts(target: string | null, max = 25): Promise<number> {
  const { data, error } = await db().rpc("claim_mission_slack_posts", { target, max_posts: max, lease_seconds: LEASE_SECONDS });
  if (error) throw error;
  let sent = 0;
  const deps = postDeps();
  for (const row of data ?? []) {
    const post = toClaimed(row);
    const outcome = await deliverPost(post, deps).catch(
      (failure: unknown): PostOutcome => ({
        status: "retry",
        error: failure instanceof Error ? failure.message : String(failure),
        delaySeconds: 30,
        inDoubt: post.inDoubt,
        progress: post.progress,
        postedTs: post.postedTs,
      }),
    );
    await record(post, outcome).catch((failure: unknown) => console.error(`Mission ${post.missionId}: couldn't record post ${post.opKey}`, failure));
    if (outcome.status === "sent") sent++;
  }
  return sent;
}

function later(work: () => Promise<unknown>): void {
  const guarded = () => work().catch((error: unknown) => console.error("Missions: sending a Slack post failed", error));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

/**
 * Queue a post under its key. A new one is queued; one under the same key
 * that failed or was dropped is queued again (as this call has it: the
 * queue checks it again before it goes, chunks already posted stay posted,
 * and one whose last send went unanswered is still looked for first); one pending or sent is left as it is, and one ambiguous too, as
 * it may have posted. Sent right after the response; the tick tries again
 * if that fails.
 */
export async function queuePost(post: QueuedPost): Promise<QueueOutcome> {
  const fields = {
    mission_id: post.missionId,
    binding_revision: post.bindingRevision,
    team_id: post.teamId,
    channel_id: post.channelId,
    thread_ts: post.threadTs,
    kind: post.kind,
    payload: post.payload as Json,
    requester: post.requester,
  };
  const { data, error } = await db()
    .from("mission_slack_posts")
    .upsert({ op_key: post.opKey, ...fields }, { onConflict: "op_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  let id: string | null = data?.[0]?.id ?? null;
  if (!id) {
    const { data: again, error: againError } = await db()
      .from("mission_slack_posts")
      .update({
        ...fields,
        status: "pending",
        attempts: 0,
        // in_doubt is kept: a send that went unanswered before it was
        // dropped is looked for in the thread before anything is posted.
        lease_until: null,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
        finished_at: null,
      })
      .eq("op_key", post.opKey)
      .in("status", ["failed", "dropped"])
      .select("id");
    if (againError) throw againError;
    id = again?.[0]?.id ?? null;
  }
  if (!id) {
    const { data: existing, error: readError } = await db().from("mission_slack_posts").select("status").eq("op_key", post.opKey).maybeSingle();
    if (readError) throw readError;
    return existing?.status === "sent" ? "already_sent" : existing?.status === "ambiguous" ? "ambiguous" : "already_pending";
  }
  const queued = id;
  // The thread's oldest goes first: sending this one may send an earlier.
  later(async () => {
    await deliverPosts(queued, 1);
    await deliverPosts(null, 5);
  });
  return "queued";
}

/** The tick's part: posts due, and old finished ones pruned. */
export async function deliverDuePosts(): Promise<number> {
  let sent = 0;
  for (let round = 0; round < 4; round++) {
    const now = await deliverPosts(null, 25);
    sent += now;
    if (now === 0) break;
  }
  await db()
    .from("mission_slack_posts")
    .delete()
    // Finished ones, kept a fortnight to look into, user content included.
    .in("status", ["sent", "dropped", "failed", "ambiguous"])
    .lt("created_at", new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString())
    .then(
      () => undefined,
      () => undefined,
    );
  return sent;
}
