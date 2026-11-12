/**
 * Jira issues and the sessions that answer them (jira_issue_sessions): service role
 * only, as the table has no policy. One row per issue: Jira has no agent sessions.
 */

import { randomUUID } from "node:crypto";

import type { WatchState } from "@/lib/session/turn-watch";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { RelayRow } from "@/lib/trackers/turn-watch-relay";

type Row = Database["public"]["Tables"]["jira_issue_sessions"]["Row"];

export type JiraStage = Row["stage"];

export type JiraRow = {
  installationId: string;
  issueId: string;
  orgId: string | null;
  itemId: string | null;
  workspaceId: string | null;
  ownerId: string | null;
  stage: JiraStage;
  prompt: string | null;
  /** No person asked: a slot of the project's day is taken when it really starts. */
  ruleStarted: boolean;
  /** The comment `prompt` quotes. */
  commentId?: string | null;
  /** The Jira user asked to link, whose link carries this on. */
  askedUser?: string | null;
  /** What they said, apart from the prompt: only their own words can name a repository. */
  askText?: string | null;
  /** The project it was connected through. */
  teamId?: string | null;
  /** Whether the issue was open when this asked something. */
  openWhenAsked?: boolean;
  /** A slot of the day already spent on what's still waiting. */
  slotTaken?: boolean;
  /** New with every stop. See {@link saveJiraRow}. */
  stopMark?: string | null;
};

/** How long one event may hold an issue. A session's start outlasts this only if it hangs. */
const CLAIM_MS = 15 * 60_000;

function db() {
  return createSupabaseAdminClient();
}

function toRow(row: Row): JiraRow {
  return {
    installationId: row.installation_id,
    issueId: row.issue_id,
    orgId: row.org_id,
    itemId: row.item_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    stage: row.stage,
    prompt: row.prompt,
    ruleStarted: row.rule_started,
    commentId: row.comment_id,
    askedUser: row.asked_user,
    askText: row.ask_text,
    teamId: row.team_id,
    openWhenAsked: row.open_when_asked,
    slotTaken: row.slot_taken,
    stopMark: row.stop_mark,
  };
}

export async function jiraRow(installationId: string, issueId: string): Promise<JiraRow | null> {
  const { data, error } = await db().from("jira_issue_sessions").select("*").eq("installation_id", installationId).eq("issue_id", issueId).maybeSingle();
  if (error) throw error;
  return data ? toRow(data) : null;
}

/**
 * The only way a row's stage changes, but for a stop. `seen` is the row this was decided from,
 * or null if there was none. False, and nothing's written, if a stop has landed since. A row
 * reads as stopped until something's asked, and each trigger is someone asking, so leaving a
 * stop takes no more than having seen it.
 */
export async function saveJiraRow(row: JiraRow, seen: JiraRow | null): Promise<boolean> {
  const values = {
      installation_id: row.installationId,
      issue_id: row.issueId,
      org_id: row.orgId,
      item_id: row.itemId,
      workspace_id: row.workspaceId,
      owner_id: row.ownerId,
      stage: row.stage,
      prompt: row.prompt,
      rule_started: row.ruleStarted,
      comment_id: row.commentId ?? null,
      asked_user: row.askedUser ?? null,
      ask_text: row.askText ?? null,
      team_id: row.teamId ?? null,
      open_when_asked: row.openWhenAsked ?? false,
      slot_taken: row.slotTaken ?? false,
  };
  const table = db().from("jira_issue_sessions");
  if (!seen) {
    const { data, error } = await table.upsert(values, { onConflict: "installation_id,issue_id", ignoreDuplicates: true }).select("issue_id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }
  const update = table.update(values).eq("installation_id", seen.installationId).eq("issue_id", seen.issueId);
  const { data, error } = await (seen.stopMark ? update.eq("stop_mark", seen.stopMark) : update.is("stop_mark", null)).select("issue_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Hold an issue while deciding what to do; false when another event already is. */
export async function claimJiraIssue(installationId: string, issueId: string, now = Date.now()): Promise<boolean> {
  const client = db();
  // There has to be a row to hold. A new one starts as stopped: it says nothing yet.
  const { error: insertError } = await client
    .from("jira_issue_sessions")
    .upsert({ installation_id: installationId, issue_id: issueId, stage: "stopped" }, { onConflict: "installation_id,issue_id", ignoreDuplicates: true });
  if (insertError) throw insertError;
  const { data, error } = await client
    .from("jira_issue_sessions")
    .update({ claim_until: new Date(now + CLAIM_MS).toISOString() })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .or(`claim_until.is.null,claim_until.lt.${new Date(now).toISOString()}`)
    .select("issue_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function releaseJiraIssue(installationId: string, issueId: string): Promise<void> {
  const { error } = await db().from("jira_issue_sessions").update({ claim_until: null }).eq("installation_id", installationId).eq("issue_id", issueId);
  if (error) throw error;
}

/** What someone just linked carries on: their delegations asked to link, from today. */
export async function jiraRowsAwaitingLink(installationId: string, externalUserId: string, since: number): Promise<JiraRow[]> {
  const { data, error } = await db()
    .from("jira_issue_sessions")
    .select("*")
    .eq("installation_id", installationId)
    .eq("asked_user", externalUserId)
    .eq("stage", "awaiting_link")
    .gt("updated_at", new Date(since).toISOString());
  if (error) throw error;
  return (data ?? []).map(toRow);
}

/** The issues a session answers, newest first. */
export async function jiraRowsForWorkspace(workspaceId: string): Promise<JiraRow[]> {
  const { data, error } = await db().from("jira_issue_sessions").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toRow);
}

/** An org left, or disconnected a project: nothing more goes there for it. */
export async function stopJiraRowsOf(installationId: string, orgId: string, teamId?: string): Promise<void> {
  const update = db().from("jira_issue_sessions").update({ stage: "stopped", relay_until: null, watch: null, stop_mark: randomUUID() }).eq("installation_id", installationId).eq("org_id", orgId).neq("stage", "stopped");
  const { error } = await (teamId ? update.eq("team_id", teamId) : update);
  if (error) throw error;
}

/** Nothing more goes to Jira for this one. With no row yet, it leaves one, for what's about
 *  to write one to find. */
export async function stopJiraRow(installationId: string, issueId: string): Promise<void> {
  const { error } = await db()
    .from("jira_issue_sessions")
    .upsert({ installation_id: installationId, issue_id: issueId, stage: "stopped", relay_until: null, watch: null, stop_mark: randomUUID() }, { onConflict: "installation_id,issue_id" });
  if (error) throw error;
}

/** Its session, once made. Leaves the stage: a stop during setup stays a stop. */
export async function setJiraRowWorkspace(installationId: string, issueId: string, workspaceId: string): Promise<void> {
  const { error } = await db().from("jira_issue_sessions").update({ workspace_id: workspaceId }).eq("installation_id", installationId).eq("issue_id", issueId);
  if (error) throw error;
}

// --- The relay ---------------------------------------------------------------

export async function jiraRelayRow(installationId: string, issueId: string): Promise<RelayRow | null> {
  const { data, error } = await db().from("jira_issue_sessions").select("*").eq("installation_id", installationId).eq("issue_id", issueId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    agentSessionId: data.issue_id,
    installationId: data.installation_id,
    issueId: data.issue_id,
    orgId: data.org_id,
    teamId: data.team_id,
    workspaceId: data.workspace_id,
    stage: data.stage,
    relayUntil: data.relay_until ? Date.parse(data.relay_until) : null,
    relayedHash: data.relayed_hash,
    watch: data.watch as unknown as WatchState | null,
    // Jira has no thoughts to pace.
    lastSaidAt: null,
    saidHash: null,
  };
}

/** A turn was sent: a new watch. Its reply may read as the last one did, and it's still news.
 *  Not on a stopped one: nothing's listening. */
export async function openJiraWatch(installationId: string, issueId: string, sent: { sentAt: number; baselineActivity: number | null }, until: number): Promise<void> {
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
    .from("jira_issue_sessions")
    .update({ watch: watch as unknown as Json, relay_until: new Date(until).toISOString(), relayed_hash: null, asked_digest: null })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .neq("stage", "stopped");
  if (error) throw error;
}

export async function saveJiraWatch(installationId: string, issueId: string, sentAt: number, state: WatchState): Promise<void> {
  const { error } = await db()
    .from("jira_issue_sessions")
    .update({ watch: state as unknown as Json })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .filter("watch->>sentAt", "eq", String(sentAt));
  if (error) throw error;
}

/** Take the end of the turn, closing its watch; false when it's been said. */
export async function claimJiraReply(installationId: string, issueId: string, digest: string, sentAt: number): Promise<boolean> {
  const { data, error } = await db()
    .from("jira_issue_sessions")
    .update({ relayed_hash: digest, relay_until: null, watch: null })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .not("relay_until", "is", null)
    .filter("watch->>sentAt", "eq", String(sentAt))
    .select("issue_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function restoreJiraReply(installationId: string, issueId: string, row: RelayRow): Promise<void> {
  const { error } = await db()
    .from("jira_issue_sessions")
    .update({
      relayed_hash: row.relayedHash,
      relay_until: row.relayUntil === null ? null : new Date(row.relayUntil).toISOString(),
      watch: row.watch as unknown as Json,
    })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .neq("stage", "stopped")
    // A turn sent since has its own watch, which this mustn't write over.
    .is("watch", null);
  if (error) throw error;
}

export async function claimJiraQuestion(installationId: string, issueId: string, digest: string): Promise<boolean> {
  const { data, error } = await db()
    .from("jira_issue_sessions")
    .update({ asked_digest: digest })
    .eq("installation_id", installationId)
    .eq("issue_id", issueId)
    .or(`asked_digest.is.null,asked_digest.neq.${digest}`)
    .select("issue_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function releaseJiraQuestion(installationId: string, issueId: string): Promise<void> {
  const { error } = await db().from("jira_issue_sessions").update({ asked_digest: null }).eq("installation_id", installationId).eq("issue_id", issueId);
  if (error) throw error;
}

/** A comment edited or deleted: the prompt that quotes it goes too, as it may be a pasted secret. */
export async function forgetJiraComment(installationId: string, commentId: string): Promise<void> {
  const { error } = await db().from("jira_issue_sessions").update({ prompt: null, comment_id: null, ask_text: null }).eq("installation_id", installationId).eq("comment_id", commentId);
  if (error) throw error;
}

/** What was said, kept no longer than it's likely to be asked about. */
export async function clearStaleJiraText(before: number): Promise<void> {
  const { error } = await db().from("jira_issue_sessions").update({ prompt: null, comment_id: null, ask_text: null }).lt("updated_at", new Date(before).toISOString()).or("prompt.not.is.null,ask_text.not.is.null");
  if (error) throw error;
}

/** Turns still watched, including those out of time, which have that to say. The least
 *  recently looked at first: a look updates the row, so none is starved. */
export async function jiraRepliesAwaited(limit = 50): Promise<{ installationId: string; issueId: string }[]> {
  const { data, error } = await db()
    .from("jira_issue_sessions")
    .select("installation_id, issue_id")
    .not("relay_until", "is", null)
    .neq("stage", "stopped")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({ installationId: row.installation_id, issueId: row.issue_id }));
}
