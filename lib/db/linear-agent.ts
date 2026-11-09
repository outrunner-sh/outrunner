/**
 * Linear agent sessions and the sessions that answer them (linear_agent_sessions):
 * service role only, as the table has no policy.
 */

import { randomUUID } from "node:crypto";

import type { WatchState } from "@/lib/session/turn-watch";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { AgentPayload } from "@/lib/trackers/linear-agent";
import type { RelayRow } from "@/lib/trackers/turn-watch-relay";

type Row = Database["public"]["Tables"]["linear_agent_sessions"]["Row"];

export type AgentStage = Row["stage"];

export type AgentRow = {
  agentSessionId: string;
  installationId: string;
  orgId: string | null;
  issueId: string;
  itemId: string | null;
  workspaceId: string | null;
  ownerId: string | null;
  stage: AgentStage;
  prompt: string | null;
  /** No person delegated it: a slot of the team's day is taken when it really starts. */
  ruleStarted: boolean;
  /** What the delegation said, kept while a question waits: a reply needn't repeat it. */
  ask: AgentPayload | null;
  /** The Linear user asked to link, whose link carries this on. */
  askedUser: string | null;
  /** An @mention opened it, and it hasn't been delegated since. */
  fromMention?: boolean;
  /** When Linear made the session (ms). */
  sessionCreatedAt?: number | null;
  /** The team it was connected through. */
  teamId?: string | null;
  /** Whether the issue was open when this asked something. */
  openWhenAsked?: boolean;
  /** A slot of the day already spent on what's still waiting. */
  slotTaken?: boolean;
  /** New with every stop. See {@link saveAgentRow}. */
  stopMark?: string | null;
};

/** How long an issue is held while one event acts on it. A session's setup outlasts this
 *  only if it hangs. */
const CLAIM_SECONDS = 15 * 60;

function db() {
  return createSupabaseAdminClient();
}

function toRow(row: Row): AgentRow {
  return {
    agentSessionId: row.agent_session_id,
    installationId: row.installation_id,
    orgId: row.org_id,
    issueId: row.issue_id,
    itemId: row.item_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    stage: row.stage,
    prompt: row.prompt,
    ruleStarted: row.rule_started,
    ask: row.ask as AgentPayload | null,
    askedUser: row.asked_user,
    fromMention: row.from_mention,
    sessionCreatedAt: row.session_created_at ? Date.parse(row.session_created_at) : null,
    teamId: row.team_id,
    openWhenAsked: row.open_when_asked,
    slotTaken: row.slot_taken,
    stopMark: row.stop_mark,
  };
}

export async function agentRow(agentSessionId: string): Promise<AgentRow | null> {
  const { data, error } = await db().from("linear_agent_sessions").select("*").eq("agent_session_id", agentSessionId).maybeSingle();
  if (error) throw error;
  return data ? toRow(data) : null;
}

/**
 * The only way a row's stage changes, but for a stop. `seen` is the row this was decided from,
 * or null if there was none. False, and nothing's written, if a stop has landed since, if a row
 * has appeared since, or if this would leave a stop without `restart`: someone asking again.
 */
export async function saveAgentRow(row: AgentRow, seen: AgentRow | null, options: { restart?: boolean } = {}): Promise<boolean> {
  if (seen?.stage === "stopped" && row.stage !== "stopped" && !options.restart) return false;
  const values = {
      agent_session_id: row.agentSessionId,
      installation_id: row.installationId,
      org_id: row.orgId,
      issue_id: row.issueId,
      item_id: row.itemId,
      workspace_id: row.workspaceId,
      owner_id: row.ownerId,
      stage: row.stage,
      prompt: row.prompt,
      rule_started: row.ruleStarted,
      ask: row.ask as unknown as Json,
      asked_user: row.askedUser,
      from_mention: row.fromMention ?? false,
      session_created_at: row.sessionCreatedAt ? new Date(row.sessionCreatedAt).toISOString() : null,
      team_id: row.teamId ?? null,
      open_when_asked: row.openWhenAsked ?? false,
      slot_taken: row.slotTaken ?? false,
  };
  const table = db().from("linear_agent_sessions");
  if (!seen) {
    const { data, error } = await table.upsert(values, { onConflict: "agent_session_id", ignoreDuplicates: true }).select("agent_session_id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }
  const update = table.update(values).eq("agent_session_id", seen.agentSessionId);
  const { data, error } = await (seen.stopMark ? update.eq("stop_mark", seen.stopMark) : update.is("stop_mark", null)).select("agent_session_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Its session, once made. Leaves the stage: a stop during setup stays a stop. */
export async function setAgentRowWorkspace(agentSessionId: string, workspaceId: string): Promise<void> {
  const { error } = await db().from("linear_agent_sessions").update({ workspace_id: workspaceId }).eq("agent_session_id", agentSessionId);
  if (error) throw error;
}

/** The rows of an issue with something under way, or a question waiting. */
export async function liveRowsForIssue(installationId: string, issueId: string): Promise<AgentRow[]> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .select("*")
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .neq("stage", "stopped");
  if (error) throw error;
  return (data ?? []).map(toRow);
}

/** The newest row of an issue. */
export async function latestRowForIssue(installationId: string, issueId: string): Promise<AgentRow | null> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .select("*")
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toRow(data) : null;
}

/** The agent sessions a session answers, newest first. */
export async function rowsForWorkspace(workspaceId: string): Promise<AgentRow[]> {
  const { data, error } = await db().from("linear_agent_sessions").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toRow);
}

/** What someone just linked carries on: their delegations asked to link, from today. */
export async function rowsAwaitingLink(installationId: string, externalUserId: string, since: number): Promise<AgentRow[]> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .select("*")
    .eq("installation_id", installationId)
    .eq("asked_user", externalUserId)
    .eq("stage", "awaiting_link")
    .gt("updated_at", new Date(since).toISOString());
  if (error) throw error;
  return (data ?? []).map(toRow);
}

/** An org left, or disconnected a team: nothing more goes there for it. */
export async function stopAgentRowsOf(installationId: string, orgId: string, teamId?: string): Promise<void> {
  const update = db().from("linear_agent_sessions").update({ stage: "stopped", relay_until: null, watch: null, stop_mark: randomUUID() }).eq("installation_id", installationId).eq("org_id", orgId).neq("stage", "stopped");
  const { error } = await (teamId ? update.eq("team_id", teamId) : update);
  if (error) throw error;
}

/** Nothing more goes to Linear for this one. */
export async function stopAgentRow(agentSessionId: string): Promise<void> {
  const { error } = await db().from("linear_agent_sessions").update({ stage: "stopped", relay_until: null, watch: null, stop_mark: randomUUID() }).eq("agent_session_id", agentSessionId);
  if (error) throw error;
}

/**
 * Hold an issue while one event acts on it, in one statement. Null: it's held now, by
 * `holder`. Otherwise who has it: the same agent session, for a delivery still being
 * handled, or another one's.
 */
export async function claimIssue(installationId: string, issueId: string, holder: string): Promise<string | null> {
  const { data, error } = await db().rpc("claim_tracker_issue", { target_installation: installationId, target_issue: issueId, claimant: holder, hold_seconds: CLAIM_SECONDS });
  if (error) throw error;
  return data ?? null;
}

export async function releaseIssue(installationId: string, issueId: string, holder: string): Promise<void> {
  const { error } = await db().from("tracker_issue_claims").delete().eq("installation_id", installationId).eq("issue_id", issueId).eq("holder", holder);
  if (error) throw error;
}

// --- The relay ---------------------------------------------------------------

function toRelayRow(row: Row): RelayRow {
  const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
  return {
    agentSessionId: row.agent_session_id,
    installationId: row.installation_id,
    orgId: row.org_id,
    teamId: row.team_id,
    workspaceId: row.workspace_id,
    stage: row.stage,
    relayUntil: ms(row.relay_until),
    relayedHash: row.relayed_hash,
    watch: row.watch as unknown as WatchState | null,
    lastSaidAt: ms(row.last_said_at),
    saidHash: row.said_hash,
  };
}

export async function agentRelayRow(agentSessionId: string): Promise<RelayRow | null> {
  const { data, error } = await db().from("linear_agent_sessions").select("*").eq("agent_session_id", agentSessionId).maybeSingle();
  if (error) throw error;
  return data ? toRelayRow(data) : null;
}

/** A turn was sent: a new watch. Its reply may read as the last one did ("Done."), and it's
 *  still news, so what was posted is forgotten. Not on a stopped one: nothing's listening. */
export async function openAgentWatch(agentSessionId: string, sent: { sentAt: number; baselineActivity: number | null }, until: number): Promise<void> {
  const watch: WatchState = {
    sentAt: sent.sentAt,
    baselineActivity: sent.baselineActivity,
    seenWorking: false,
    quietSince: null,
    quietActivity: null,
    lastMessage: null,
    unreachableSince: null,
  };
  const { error } = await db()
    .from("linear_agent_sessions")
    .update({ watch: watch as unknown as Json, relay_until: new Date(until).toISOString(), relayed_hash: null, asked_digest: null, last_said_at: new Date(sent.sentAt).toISOString() })
    .eq("agent_session_id", agentSessionId)
    .neq("stage", "stopped");
  if (error) throw error;
}

export async function saveAgentWatch(agentSessionId: string, sentAt: number, state: WatchState): Promise<void> {
  const { error } = await db()
    .from("linear_agent_sessions")
    .update({ watch: state as unknown as Json })
    .eq("agent_session_id", agentSessionId)
    .filter("watch->>sentAt", "eq", String(sentAt));
  if (error) throw error;
}

/** Take the end of the turn, closing its watch; false when it's been said. */
export async function claimAgentReply(agentSessionId: string, digest: string, sentAt: number): Promise<boolean> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .update({ relayed_hash: digest, relay_until: null, watch: null })
    .eq("agent_session_id", agentSessionId)
    .not("relay_until", "is", null)
    .filter("watch->>sentAt", "eq", String(sentAt))
    .select("agent_session_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function restoreAgentReply(agentSessionId: string, row: RelayRow): Promise<void> {
  const { error } = await db()
    .from("linear_agent_sessions")
    .update({
      relayed_hash: row.relayedHash,
      relay_until: row.relayUntil === null ? null : new Date(row.relayUntil).toISOString(),
      watch: row.watch as unknown as Json,
    })
    .eq("agent_session_id", agentSessionId)
    .neq("stage", "stopped")
    // A turn sent since has its own watch, which this mustn't write over.
    .is("watch", null);
  if (error) throw error;
}

export async function claimAgentQuestion(agentSessionId: string, digest: string): Promise<boolean> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .update({ asked_digest: digest, last_said_at: new Date().toISOString() })
    .eq("agent_session_id", agentSessionId)
    .or(`asked_digest.is.null,asked_digest.neq.${digest}`)
    .select("agent_session_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function releaseAgentQuestion(agentSessionId: string): Promise<void> {
  const { error } = await db().from("linear_agent_sessions").update({ asked_digest: null }).eq("agent_session_id", agentSessionId);
  if (error) throw error;
}

/** Take the next thought, unless something was said since `cutoff`. */
export async function claimAgentThought(agentSessionId: string, cutoff: number, now: number, saidHash: string | null): Promise<boolean> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .update({ last_said_at: new Date(now).toISOString(), said_hash: saidHash })
    .eq("agent_session_id", agentSessionId)
    .or(`last_said_at.is.null,last_said_at.lte.${new Date(cutoff).toISOString()}`)
    .select("agent_session_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function restoreAgentThought(agentSessionId: string, previous: { lastSaidAt: number | null; saidHash: string | null }): Promise<void> {
  const { error } = await db()
    .from("linear_agent_sessions")
    .update({ last_said_at: previous.lastSaidAt === null ? null : new Date(previous.lastSaidAt).toISOString(), said_hash: previous.saidHash })
    .eq("agent_session_id", agentSessionId);
  if (error) throw error;
}

/** Turns still watched, including those out of time, which have that to say. The least
 *  recently looked at first: a look updates the row. */
export async function agentRepliesAwaited(limit = 50): Promise<string[]> {
  const { data, error } = await db()
    .from("linear_agent_sessions")
    .select("agent_session_id")
    .not("relay_until", "is", null)
    .neq("stage", "stopped")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => row.agent_session_id);
}

/** A comment edited or deleted: what a waiting question kept of it goes too, as it may be a
 *  pasted secret. Linear's own context may quote it, so that goes with it. */
export async function forgetAgentComment(commentId: string): Promise<void> {
  const { data, error } = await db().from("linear_agent_sessions").select("agent_session_id, ask").filter("ask->agentSession->comment->>id", "eq", commentId);
  if (error) throw error;
  for (const row of data ?? []) {
    const ask = row.ask as AgentPayload;
    const kept: AgentPayload = { ...ask, promptContext: undefined, agentSession: { ...ask.agentSession, comment: null } };
    const { error: updateError } = await db().from("linear_agent_sessions").update({ ask: kept as unknown as Json, prompt: null }).eq("agent_session_id", row.agent_session_id);
    if (updateError) throw updateError;
  }
}

/** What a delegation said, kept no longer than it's likely to be asked about. */
export async function clearStaleAgentText(before: number): Promise<void> {
  const { error } = await db()
    .from("linear_agent_sessions")
    .update({ ask: null, prompt: null })
    .lt("updated_at", new Date(before).toISOString())
    .or("ask.not.is.null,prompt.not.is.null");
  if (error) throw error;
}

/** Take one of today's rule-started sessions for a team; false at its cap. */
export async function claimRuleSession(scopeId: string): Promise<boolean> {
  const { data, error } = await db().rpc("claim_rule_session", { target_scope: scopeId });
  if (error) throw error;
  return data === true;
}
