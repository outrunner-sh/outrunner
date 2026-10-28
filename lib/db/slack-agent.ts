/**
 * The Slack agent's records (20261031100000_slack_agent.sql): the app's
 * install per Slack workspace (its bot token, sealed), the threads it's in,
 * the events it has handled, and each org's own key for the models the agent
 * runs on. All the server's (service role).
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { outrunnerModelKey } from "@/lib/db/credentials";
import { keySource, ModelKeyRefusedError, OutrunnerModelsUnavailableError, sharedApiKey } from "@/lib/openrouter/keys";
import { orgOutrunnerModelKey } from "@/lib/db/org-model-allowance";
import { personalOwners } from "@/lib/db/orgs";
import type { AgentSpec } from "@/lib/slack/agent";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

function db() {
  return createSupabaseAdminClient();
}

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

export type SlackInstallation = { teamId: string; teamName: string | null; botUserId: string; botToken: string };

/** Keep the bot token an install gave (installing again replaces it). */
export async function saveInstallation(install: SlackInstallation): Promise<void> {
  const { error } = await db().from("slack_installations").upsert(
    {
      team_id: install.teamId,
      team_name: install.teamName,
      bot_user_id: install.botUserId,
      bot_token_ciphertext: seal(install.botToken),
    },
    { onConflict: "team_id" },
  );
  if (error) throw error;
}

/** The app's install in a Slack workspace; null when it isn't installed
 *  there (or was installed before the bot token was kept: install again). */
export async function getInstallation(teamId: string): Promise<SlackInstallation | null> {
  const { data, error } = await db().from("slack_installations").select("*").eq("team_id", teamId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { teamId: data.team_id, teamName: data.team_name, botUserId: data.bot_user_id, botToken: open(data.bot_token_ciphertext) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** True the first time an event id is seen; false for Slack sending it again. */
export async function firstSighting(eventId: string): Promise<boolean> {
  const client = db();
  const { error } = await client.from("slack_events_seen").insert({ event_id: eventId });
  if (error?.code === "23505") return false;
  if (error) throw error;
  // Slack retries within minutes: a day's ids are plenty to keep.
  void client
    .from("slack_events_seen")
    .delete()
    .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .then(() => undefined, () => undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationState = "gathering" | "proposed" | "filed" | "started";

export type SlackConversation = {
  id: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  orgId: string;
  startedBy: string | null;
  state: ConversationState;
  rounds: number;
  proposal: AgentSpec | null;
  proposalTs: string | null;
  itemId: string | null;
  workspaceId: string | null;
  /** The thread's research session (lib/slack/research.ts). */
  researchWorkspaceId: string | null;
  /** Its session's pull request, as the webhook saw it open. */
  pr: { repo: string; number: number; url: string } | null;
  /** The validator comment last posted in the thread. */
  verdictCommentId: number | null;
  mergedAnnounced: boolean;
};

type ConversationRow = {
  id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  org_id: string;
  started_by: string | null;
  state: ConversationState;
  rounds: number;
  proposal: Json | null;
  proposal_ts: string | null;
  item_id: string | null;
  workspace_id: string | null;
  research_workspace_id: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_url: string | null;
  verdict_comment_id: number | null;
  merged_announced: boolean;
};

function toConversation(row: ConversationRow): SlackConversation {
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    orgId: row.org_id,
    startedBy: row.started_by,
    state: row.state,
    rounds: row.rounds,
    proposal: (row.proposal as AgentSpec | null) ?? null,
    proposalTs: row.proposal_ts,
    itemId: row.item_id,
    workspaceId: row.workspace_id,
    researchWorkspaceId: row.research_workspace_id,
    pr: row.pr_repo && row.pr_number && row.pr_url ? { repo: row.pr_repo, number: row.pr_number, url: row.pr_url } : null,
    verdictCommentId: row.verdict_comment_id,
    mergedAnnounced: row.merged_announced,
  };
}

export async function getConversation(teamId: string, channelId: string, threadTs: string): Promise<SlackConversation | null> {
  const { data, error } = await db()
    .from("slack_conversations")
    .select("*")
    .eq("team_id", teamId)
    .eq("channel_id", channelId)
    .eq("thread_ts", threadTs)
    .maybeSingle();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

export async function getConversationById(id: string): Promise<SlackConversation | null> {
  const { data, error } = await db().from("slack_conversations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

/** The thread's conversation, made on first mention (two mentions at once
 *  share one). */
export async function openConversation(input: {
  teamId: string;
  channelId: string;
  threadTs: string;
  orgId: string;
  startedBy: string;
}): Promise<SlackConversation> {
  const { error } = await db().from("slack_conversations").upsert(
    {
      team_id: input.teamId,
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      org_id: input.orgId,
      started_by: input.startedBy,
    },
    { onConflict: "team_id,channel_id,thread_ts", ignoreDuplicates: true },
  );
  if (error) throw error;
  const conversation = await getConversation(input.teamId, input.channelId, input.threadTs);
  if (!conversation) throw new Error("The conversation wasn't recorded.");
  return conversation;
}

export async function updateConversation(
  id: string,
  patch: Partial<{
    state: ConversationState;
    rounds: number;
    proposal: AgentSpec | null;
    proposalTs: string | null;
    itemId: string | null;
    workspaceId: string | null;
    researchWorkspaceId: string | null;
    pr: { repo: string; number: number; url: string };
    verdictCommentId: number | null;
    mergedAnnounced: boolean;
  }>,
): Promise<void> {
  const { error } = await db()
    .from("slack_conversations")
    .update({
      ...(patch.state !== undefined && { state: patch.state }),
      ...(patch.rounds !== undefined && { rounds: patch.rounds }),
      ...(patch.proposal !== undefined && { proposal: patch.proposal as unknown as Json }),
      ...(patch.proposalTs !== undefined && { proposal_ts: patch.proposalTs }),
      ...(patch.itemId !== undefined && { item_id: patch.itemId }),
      ...(patch.workspaceId !== undefined && { workspace_id: patch.workspaceId }),
      ...(patch.researchWorkspaceId !== undefined && { research_workspace_id: patch.researchWorkspaceId }),
      ...(patch.pr !== undefined && { pr_repo: patch.pr.repo, pr_number: patch.pr.number, pr_url: patch.pr.url }),
      ...(patch.verdictCommentId !== undefined && { verdict_comment_id: patch.verdictCommentId }),
      ...(patch.mergedAnnounced !== undefined && { merged_announced: patch.mergedAnnounced }),
    })
    .eq("id", id);
  if (error) throw error;
}

/** Threads whose session has a pull request still to follow: not yet
 *  announced as merged. */
export async function conversationsWithOpenPullRequests(limit = 25): Promise<SlackConversation[]> {
  const { data, error } = await db()
    .from("slack_conversations")
    .select("*")
    .not("pr_number", "is", null)
    .eq("merged_announced", false)
    // Least recently checked first: every open one gets its turn.
    .order("pr_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length) {
    const { error: touchError } = await db()
      .from("slack_conversations")
      .update({ pr_checked_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));
    if (touchError) throw touchError;
  }
  return rows.map(toConversation);
}

/** Claim a verdict comment for posting: false when it's already been posted
 *  (by an overlapping tick), or an older one is all this is. */
export async function claimVerdict(id: string, commentId: number): Promise<boolean> {
  const { data, error } = await db()
    .from("slack_conversations")
    .update({ verdict_comment_id: commentId })
    .eq("id", id)
    .or(`verdict_comment_id.is.null,verdict_comment_id.lt.${commentId}`)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Claim announcing the end of a thread's pull request (merged or closed):
 *  once. */
export async function claimPullRequestEnd(id: string): Promise<boolean> {
  const { data, error } = await db()
    .from("slack_conversations")
    .update({ merged_announced: true })
    .eq("id", id)
    .eq("merged_announced", false)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** The thread a session was started from, if it was. */
export async function conversationForWorkspace(workspaceId: string): Promise<SlackConversation | null> {
  const { data, error } = await db().from("slack_conversations").select("*").eq("workspace_id", workspaceId).limit(1).maybeSingle();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

/** The thread a work item was filed from, if it came from the agent. */
export async function conversationForItem(itemId: string): Promise<SlackConversation | null> {
  const { data, error } = await db().from("slack_conversations").select("*").eq("item_id", itemId).limit(1).maybeSingle();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

/**
 * A session as the server sees it, with no one signed in: getWorkspace reads
 * through the signed-in user's client, which the Slack agent (after Slack's
 * answer, or on the cron) doesn't have.
 */
export async function sessionSummary(
  workspaceId: string,
): Promise<{ id: string; ownerId: string; projectId: string; status: string } | null> {
  const { data, error } = await db()
    .from("workspaces")
    .select("id, owner_id, project_id, status")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, ownerId: data.owner_id, projectId: data.project_id, status: data.status } : null;
}

// ---------------------------------------------------------------------------
// The org's model key
// ---------------------------------------------------------------------------

/**
 * The OpenRouter key the Slack agent's calls for an org run on, so the org
 * pays for them: the one its members' cloud sessions run Outrunner's models
 * on, within the same allowance from its plan (one budget per org). A team
 * org's own key (lib/db/org-model-allowance.ts); a personal org's, its
 * owner's. The shared API key where the server has only that. A spent
 * allowance is refused (ModelKeyRefusedError), as for a session.
 */
export async function orgModelKey(orgId: string): Promise<string> {
  // Without per-org keys there's no one to look up.
  const source = keySource();
  if (source === null) throw new OutrunnerModelsUnavailableError();
  if (source === "shared") return sharedApiKey() as string;
  const owner = (await personalOwners([orgId])).get(orgId);
  return owner ? outrunnerModelKey(owner) : orgOutrunnerModelKey(orgId);
}

/** How long a watched channel's answer stands (a key, or a refusal that
 *  won't change in a minute): it asks at every message, and each full ask
 *  reads the key's usage from OpenRouter. OpenRouter's own cap still holds
 *  in between. */
const WATCH_ANSWER_MS = 60_000;
const watchAnswers = new Map<string, { at: number; answer: Promise<string> }>();

/** A refusal worth keeping: the allowance spent, the key off, or no models
 *  on this server. A failure to ask (a blip) is asked again next time. */
function lasting(error: unknown): boolean {
  return error instanceof ModelKeyRefusedError || error instanceof OutrunnerModelsUnavailableError;
}

/**
 * {@link orgModelKey} for a watched channel's message: the last minute's
 * answer, a lasting refusal included, so a busy channel neither asks
 * OpenRouter at every message nor, once the allowance is spent, at every one
 * after. Messages arriving together share one ask. A reply to someone always
 * asks afresh (orgModelKey).
 */
export function watchModelKey(orgId: string): Promise<string> {
  const now = Date.now();
  const kept = watchAnswers.get(orgId);
  if (kept && now - kept.at < WATCH_ANSWER_MS) return kept.answer;
  const answer = orgModelKey(orgId);
  watchAnswers.set(orgId, { at: now, answer });
  answer.catch((error: unknown) => {
    // Said once per ask: a lasting refusal once a minute, a blip each time
    // it happens (it isn't kept, so the next message asks again).
    console.error(`Slack agent: no model key for org ${orgId}'s watched channels`, error);
    if (!lasting(error) && watchAnswers.get(orgId)?.answer === answer) watchAnswers.delete(orgId);
  });
  return answer;
}

/** Forget the org's kept answer: OpenRouter refused the key it gave. */
export function forgetWatchModelKey(orgId: string): void {
  watchAnswers.delete(orgId);
}
