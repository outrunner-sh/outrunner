/**
 * A Mission on call in Slack, in the database (20261118110000_mission_slack.sql),
 * with the service role: the channel it's bound to, the threads it took, the
 * Ships it started for them under its limits, and its question cards. The
 * callers have checked who may (lib/missions/slack-route.ts, the Mission's
 * tools and its routes).
 */

import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** The channel a Mission is on call in. */
export type MissionChannel = {
  missionId: string;
  orgId: string;
  teamId: string;
  channelId: string;
  boundBy: string | null;
  listen: "mentions" | "all";
  allowBotMessages: boolean;
  paused: boolean;
  /** New each time it's bound: what's queued under one never goes under
   *  another. */
  revision: string;
};

/** A thread the Mission took a request in. */
export type MissionThread = {
  id: string;
  missionId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  permalink: string | null;
  startedBy: string | null;
  startedBySlack: string | null;
  lastRequestTs: string | null;
  muted: boolean;
};

type ChannelRow = {
  mission_id: string;
  org_id: string;
  slack_team_id: string;
  channel_id: string;
  bound_by: string | null;
  listen: "mentions" | "all";
  allow_bot_messages: boolean;
  paused: boolean;
  revision?: string;
};

type ThreadRow = {
  id: string;
  mission_id: string;
  slack_team_id: string;
  channel_id: string;
  thread_ts: string;
  permalink: string | null;
  started_by: string | null;
  started_by_slack: string | null;
  last_request_ts: string | null;
  muted: boolean;
};

function toChannel(row: ChannelRow): MissionChannel {
  return {
    missionId: row.mission_id,
    orgId: row.org_id,
    teamId: row.slack_team_id,
    channelId: row.channel_id,
    boundBy: row.bound_by,
    listen: row.listen,
    allowBotMessages: row.allow_bot_messages,
    paused: row.paused,
    // Before the reliability migration, one revision for the binding's life.
    revision: row.revision ?? `${row.mission_id}:${row.slack_team_id}:${row.channel_id}`,
  };
}

function toThread(row: ThreadRow): MissionThread {
  return {
    id: row.id,
    missionId: row.mission_id,
    teamId: row.slack_team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    permalink: row.permalink,
    startedBy: row.started_by,
    startedBySlack: row.started_by_slack,
    lastRequestTs: row.last_request_ts,
    muted: row.muted,
  };
}

/** The Mission on call in a channel, if one is (none before the on-call
 *  migration is applied). */
export async function channelBinding(teamId: string, channelId: string): Promise<MissionChannel | null> {
  const { data, error } = await db().from("mission_channels").select("*").eq("slack_team_id", teamId).eq("channel_id", channelId).maybeSingle();
  if (error && missingTable(error)) return null;
  if (error) throw error;
  return data ? toChannel(data) : null;
}

/** The table isn't there: the on-call migration isn't applied yet
 *  (Postgres's undefined_table, or PostgREST's schema cache saying so). */
function missingTable(error: { code?: string }): boolean {
  return error.code === "42P01" || error.code === "PGRST205";
}

/** The channel a Mission is on call in, if any. Before the on-call
 *  migration is applied, none: every Mission works as before. */
export async function missionBinding(missionId: string): Promise<MissionChannel | null> {
  const { data, error } = await db().from("mission_channels").select("*").eq("mission_id", missionId).maybeSingle();
  if (error && missingTable(error)) return null;
  if (error) throw error;
  return data ? toChannel(data) : null;
}

export type BindOutcome = "bound" | "channel_taken" | "mission_bound";

/** Put the Mission on call in the channel. The table's keys say no to a
 *  channel with a Mission already, and to a Mission on call elsewhere. */
export async function bindChannel(input: { missionId: string; orgId: string; teamId: string; channelId: string; boundBy: string }): Promise<BindOutcome> {
  const { error } = await db().from("mission_channels").insert({
    mission_id: input.missionId,
    org_id: input.orgId,
    slack_team_id: input.teamId,
    channel_id: input.channelId,
    bound_by: input.boundBy,
  });
  if (!error) return "bound";
  if (error.code === "23505") return error.message.includes("mission_channels_channel_unique") ? "channel_taken" : "mission_bound";
  throw error;
}

/** Take the Mission off call; true when it was on. */
export async function unbindChannel(missionId: string): Promise<boolean> {
  const { data, error } = await db().from("mission_channels").delete().eq("mission_id", missionId).select("mission_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function setChannelPaused(missionId: string, paused: boolean): Promise<boolean> {
  const { data, error } = await db().from("mission_channels").update({ paused }).eq("mission_id", missionId).select("mission_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A thread in a channel, whichever Mission's. */
export async function channelThread(teamId: string, channelId: string, threadTs: string): Promise<MissionThread | null> {
  const { data, error } = await db()
    .from("mission_threads")
    .select("*")
    .eq("slack_team_id", teamId)
    .eq("channel_id", channelId)
    .eq("thread_ts", threadTs)
    .maybeSingle();
  if (error) throw error;
  return data ? toThread(data) : null;
}

/** One of the Mission's own threads, by its ts; null for any other. */
export async function missionThread(missionId: string, threadTs: string): Promise<MissionThread | null> {
  const { data, error } = await db().from("mission_threads").select("*").eq("mission_id", missionId).eq("thread_ts", threadTs).limit(1).maybeSingle();
  if (error) throw error;
  return data ? toThread(data) : null;
}

export async function threadById(id: string): Promise<MissionThread | null> {
  const { data, error } = await db().from("mission_threads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toThread(data) : null;
}

/** The Mission's thread most lately asked in, in the channel it's on call
 *  in now, that isn't muted. */
export async function latestThread(binding: { missionId: string; teamId: string; channelId: string }): Promise<MissionThread | null> {
  const { data, error } = await db()
    .from("mission_threads")
    .select("*")
    .eq("mission_id", binding.missionId)
    .eq("slack_team_id", binding.teamId)
    .eq("channel_id", binding.channelId)
    .eq("muted", false)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toThread(data) : null;
}

/** The thread is the Mission's from this request on: made, or handed over
 *  from the channel's Mission before, with its newest request. */
export async function acceptThread(input: {
  missionId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  requestTs: string;
  permalink: string | null;
  startedBy: string | null;
  startedBySlack: string | null;
}): Promise<MissionThread> {
  const existing = await channelThread(input.teamId, input.channelId, input.threadTs);
  if (existing) {
    const { data, error } = await db()
      .from("mission_threads")
      .update({
        mission_id: input.missionId,
        last_request_ts: input.requestTs,
        ...(existing.missionId !== input.missionId && { muted: false }),
        ...(!existing.permalink && input.permalink && { permalink: input.permalink }),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return toThread(data);
  }
  const { data, error } = await db()
    .from("mission_threads")
    .upsert(
      {
        mission_id: input.missionId,
        slack_team_id: input.teamId,
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        last_request_ts: input.requestTs,
        permalink: input.permalink,
        started_by: input.startedBy,
        started_by_slack: input.startedBySlack,
      },
      { onConflict: "slack_team_id,channel_id,thread_ts" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return toThread(data);
}

export async function setThreadMuted(threadId: string, muted: boolean): Promise<void> {
  const { error } = await db().from("mission_threads").update({ muted }).eq("id", threadId);
  if (error) throw error;
}

export async function linkSlackShip(id: string, runnerId: string): Promise<void> {
  const { error } = await db().from("mission_slack_ships").update({ runner_id: runnerId }).eq("id", id);
  if (error) throw error;
}

export async function releaseSlackShip(id: string): Promise<void> {
  const { error } = await db().rpc("release_mission_slack_ship", { target: id });
  if (error) throw error;
}

/** Each of these Ships' thread links, for the Ships pane. */
export async function shipThreadLinks(runnerIds: string[]): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (runnerIds.length === 0) return links;
  const { data, error } = await db().from("mission_slack_ships").select("runner_id, thread_id").in("runner_id", runnerIds);
  if (error) throw error;
  const threadIds = [...new Set((data ?? []).flatMap((r) => (r.thread_id ? [r.thread_id] : [])))];
  if (threadIds.length === 0) return links;
  const { data: threads, error: threadsError } = await db().from("mission_threads").select("id, permalink").in("id", threadIds);
  if (threadsError) throw threadsError;
  const permalinkOf = new Map((threads ?? []).map((t) => [t.id, t.permalink]));
  for (const row of data ?? []) {
    const link = row.runner_id && row.thread_id ? permalinkOf.get(row.thread_id) : null;
    if (row.runner_id && link) links.set(row.runner_id, link);
  }
  return links;
}

export async function setAskMessage(id: string, messageTs: string): Promise<void> {
  const { error } = await db().from("mission_slack_asks").update({ message_ts: messageTs }).eq("id", id);
  if (error) throw error;
}

export type MissionAsk = {
  id: string;
  missionId: string;
  threadId: string;
  question: string;
  options: string[];
  messageTs: string | null;
  answeredAt: string | null;
  /** The binding it was asked under; null before that was kept. */
  bindingRevision: string | null;
};

export async function askById(id: string): Promise<MissionAsk | null> {
  const { data, error } = await db().from("mission_slack_asks").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data
    ? {
        id: data.id,
        missionId: data.mission_id,
        threadId: data.thread_id,
        question: data.question,
        options: data.options,
        messageTs: data.message_ts,
        answeredAt: data.answered_at,
        bindingRevision: data.binding_revision,
      }
    : null;
}

/** The Mission's question cards on screen and not answered: what a Mission
 *  going off call leaves behind. */
export async function openAsks(missionId: string): Promise<MissionAsk[]> {
  const { data, error } = await db()
    .from("mission_slack_asks")
    .select("*")
    .eq("mission_id", missionId)
    .is("answered_at", null)
    .not("message_ts", "is", null);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    missionId: row.mission_id,
    threadId: row.thread_id,
    question: row.question,
    options: row.options,
    messageTs: row.message_ts,
    answeredAt: row.answered_at,
    bindingRevision: row.binding_revision,
  }));
}

/** The card's answer, claimed: true for the first only. */
export async function claimAnswer(id: string, answer: { text: string; userId: string; slackUserId: string }): Promise<boolean> {
  const { data, error } = await db()
    .from("mission_slack_asks")
    .update({ answer: answer.text, answered_by: answer.userId, answered_by_slack: answer.slackUserId, answered_at: new Date().toISOString() })
    .eq("id", id)
    .is("answered_at", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Requests, spawn keys, the post queue (20261118110100_mission_slack_reliability.sql)
// ---------------------------------------------------------------------------

/** A Slack request a Mission took: its key, thread, who asked, and the
 *  binding it came in under. */
export type MissionRequest = {
  missionId: string;
  requestKey: string;
  threadId: string | null;
  bindingRevision: string | null;
  messageTs: string | null;
  requestedBy: string | null;
  requestedBySlack: string | null;
};

function toRequest(row: {
  mission_id: string;
  request_key: string;
  thread_id: string | null;
  binding_revision: string | null;
  message_ts: string | null;
  requested_by: string | null;
  requested_by_slack: string | null;
}): MissionRequest {
  return {
    missionId: row.mission_id,
    requestKey: row.request_key,
    threadId: row.thread_id,
    bindingRevision: row.binding_revision,
    messageTs: row.message_ts,
    requestedBy: row.requested_by,
    requestedBySlack: row.requested_by_slack,
  };
}

/** Record a request, once: a retry of it changes nothing. */
export async function recordRequest(request: MissionRequest): Promise<void> {
  const { error } = await db()
    .from("mission_slack_requests")
    .upsert(
      {
        mission_id: request.missionId,
        request_key: request.requestKey,
        thread_id: request.threadId,
        binding_revision: request.bindingRevision,
        message_ts: request.messageTs,
        requested_by: request.requestedBy,
        requested_by_slack: request.requestedBySlack,
      },
      { onConflict: "mission_id,request_key", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function requestByKey(missionId: string, requestKey: string): Promise<MissionRequest | null> {
  const { data, error } = await db().from("mission_slack_requests").select("*").eq("mission_id", missionId).eq("request_key", requestKey).maybeSingle();
  if (error) throw error;
  return data ? toRequest(data) : null;
}

/** A thread's newest request. */
export async function latestRequest(threadId: string): Promise<MissionRequest | null> {
  const { data, error } = await db()
    .from("mission_slack_requests")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toRequest(data) : null;
}

export type SpawnReservation =
  | { refused: "hour" | "day"; limit: number }
  | { id: string; plannedRunnerId: string; runnerId: string | null; existing: boolean };

/** Reserve a Ship start under its key (reserve_mission_slack_spawn). */
export async function reserveSpawn(input: {
  missionId: string;
  requestKey: string | null;
  spawnKey: string;
  threadId: string | null;
  requester: string | null;
  requesterSlack: string | null;
  revision: string;
}): Promise<SpawnReservation> {
  const { data, error } = await db().rpc("reserve_mission_slack_spawn", {
    target: input.missionId,
    request: input.requestKey,
    spawn: input.spawnKey,
    thread: input.threadId,
    requester: input.requester,
    slack_user: input.requesterSlack,
    revision: input.revision,
  });
  if (error) throw error;
  const row = data?.[0];
  if (row?.ship_id && row.planned_runner_id) {
    return { id: row.ship_id, plannedRunnerId: row.planned_runner_id, runnerId: row.runner_id, existing: row.existing };
  }
  const refused = row?.refusal === "day" ? "day" : "hour";
  return { refused, limit: row?.refused_at_limit ?? (refused === "day" ? 30 : 6) };
}

/** A Ship's place in the ledger: its request, who asked, the binding. */
export type ShipLedger = {
  requestKey: string | null;
  requestedBy: string | null;
  bindingRevision: string | null;
  thread: MissionThread | null;
};

export async function shipLedger(runnerId: string): Promise<ShipLedger | null> {
  const { data, error } = await db()
    .from("mission_slack_ships")
    .select("request_key, requested_by, binding_revision, thread_id")
    .eq("runner_id", runnerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    requestKey: data.request_key,
    requestedBy: data.requested_by,
    bindingRevision: data.binding_revision,
    thread: data.thread_id ? await threadById(data.thread_id) : null,
  };
}

/** Whether a thread is muted (a thread no Mission took isn't). */
export async function threadMuted(teamId: string, channelId: string, threadTs: string): Promise<boolean> {
  return (await channelThread(teamId, channelId, threadTs))?.muted ?? false;
}

/** A question card under its key: the one there already, if it was asked. */
export async function saveAskOnce(input: { missionId: string; threadId: string; question: string; options: string[]; opKey: string; bindingRevision: string }): Promise<string> {
  const { data, error } = await db()
    .from("mission_slack_asks")
    .upsert(
      { mission_id: input.missionId, thread_id: input.threadId, question: input.question, options: input.options, op_key: input.opKey, binding_revision: input.bindingRevision },
      { onConflict: "op_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  if (data?.[0]) return data[0].id;
  const { data: found, error: findError } = await db().from("mission_slack_asks").select("id").eq("op_key", input.opKey).single();
  if (findError) throw findError;
  return found.id;
}
