/**
 * The server's watch on its sessions: what each agent is doing, read from its
 * box's conversation stream and kept in session_activity, which is what the
 * sidebar's groups are worked out from (lib/session/standing.ts). Read
 *
 *   - closely after something is sent to a session (watchAfterSend, in
 *     after()): every few seconds, until its turn ends or it waits on you;
 *   - by the sessions tick (app/api/sessions/tick), every two minutes, for
 *     every session whose box is up, which catches turns started anywhere
 *     else (the terminal, Slack, an automation).
 *
 * Reading the stream is a GET, which the agent doesn't count as activity: the
 * watch never keeps an idle box up.
 */

import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { AgentClient } from "@/lib/runtime/agent-client";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import { toRuntimeComputer, toWorkspace } from "@/lib/db/mappers";
import { notifyActivity } from "@/lib/notifications/record";
import { closeSessionGap, recordSessionCalls, recordSessionGap } from "@/lib/missions/spend.deps";
import { readStream } from "@/lib/session/event-stream";
import { foldEvents, IDLE, type TurnState } from "@/lib/session/turn-state";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type ActivityRow = Database["public"]["Tables"]["session_activity"]["Row"];

/** What a read changed: the activity before it (null for a session not read
 *  before) and after. */
export type ActivityChange = { workspaceId: string; ownerId: string; before: TurnState | null; after: TurnState };

/** How long a session is read closely after a send, and how often. */
const CLOSE_WATCH_MS = 10 * 60_000;
const CLOSE_WATCH_EVERY_MS = 8_000;
/** How long the tick keeps reading a session after a send, for turns that
 *  outlast the close watch even if its box looks idle meanwhile. */
const WATCH_FOR_MS = 2 * 60 * 60_000;

function db() {
  return createSupabaseAdminClient();
}

export function rowToTurn(row: ActivityRow): TurnState {
  return {
    turn: row.turn,
    turnStartedAt: row.turn_started_at,
    waiting: row.waiting,
    waitingToolId: row.waiting_tool_id,
    waitingSince: row.waiting_since,
    repliedAt: row.replied_at,
    replyPreview: row.reply_preview,
    eventAt: row.event_at,
  };
}

function turnToRow(state: TurnState) {
  return {
    turn: state.turn,
    turn_started_at: state.turnStartedAt,
    waiting: state.waiting,
    waiting_tool_id: state.waitingToolId,
    waiting_since: state.waitingSince,
    replied_at: state.repliedAt,
    reply_preview: state.replyPreview,
    event_at: state.eventAt,
  };
}

/** The statuses whose box runs the agent: the only ones read. */
const LIVE = ["ready", "idle"] as const;

/**
 * Read what's new on a session's stream and record it. Null when nothing was
 * read: its box is down, the session gone, or another read got there first
 * (each read claims the cursor it started from, so two at once fold the same
 * events once).
 */
export async function readSession(workspaceId: string): Promise<ActivityChange | null> {
  const { data: row, error } = await db().from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const workspace = toWorkspace(row);
  const { data: activity, error: activityError } = await db()
    .from("session_activity")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (activityError) throw activityError;
  const before = activity ? rowToTurn(activity) : null;

  // Paused, archived or gone: it's doing nothing, whatever it last did.
  if (!(LIVE as readonly string[]).includes(workspace.status)) return settle(workspace, activity);

  const box = await upBox(workspace);
  // Its box stopped under it (lost, or paused for a turn stuck too long):
  // nothing runs there, so a turn it was in the middle of is over. Kept
  // "working", the sidebar would spin, and its queue wait, until it's opened.
  if (box === "down") return settle(workspace, activity);
  if (!box) return null;
  // A session restored onto another box has a log of its own there.
  const sameBox = activity?.stream_box === box.sandboxId;
  const cursor = sameBox ? Number(activity?.stream_cursor ?? 0) : 0;
  const url = new URL(
    new AgentClient(box.target).eventsSseUrl({
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      computerId: box.computerId,
      userId: workspace.ownerId,
    }),
  );
  if (cursor > 0) url.searchParams.set("lastEventId", String(cursor));
  const read = await readStream(url.toString(), cursor);
  // A Mission's or Ship's model calls, before the cursor moves past them: a
  // failure leaves them to be read again, and each call counts once however
  // often it's read (docs/mission-spend.md).
  await recordSessionCalls(workspace, read.events);
  // Read on from where a cut-off turn left it, on the same box (whatever
  // the turn shows now: a send that woke the box marks it working first):
  // that stretch is being read after all. Box, cursor and last read name the
  // gap's entries exactly, so they're deleted by key.
  if (sameBox && activity?.stream_box) {
    await closeSessionGap(workspace, { box: activity.stream_box, cursor, at: activity.read_at });
  }
  // From the start of a log, the state starts over, but a reply already
  // known stays known (its unread mark mustn't come back on a new box).
  const from = sameBox && before ? before : { ...IDLE, repliedAt: before?.repliedAt ?? null, replyPreview: before?.replyPreview ?? null };
  const after = foldEvents(from, read.events);
  const now = new Date().toISOString();
  const patch = { ...turnToRow(after), stream_cursor: read.cursor, stream_box: box.sandboxId, read_at: now, updated_at: now };

  if (!activity) {
    const { error: insertError, data: inserted } = await db()
      .from("session_activity")
      .upsert({ workspace_id: workspaceId, owner_id: workspace.ownerId, ...patch }, { onConflict: "workspace_id", ignoreDuplicates: true })
      .select("workspace_id");
    if (insertError) throw insertError;
    if (!inserted?.length) return null;
  } else {
    let claim = db().from("session_activity").update(patch).eq("workspace_id", workspaceId).eq("stream_cursor", activity.stream_cursor);
    claim = activity.stream_box === null ? claim.is("stream_box", null) : claim.eq("stream_box", activity.stream_box);
    const { data: claimed, error: updateError } = await claim.select("workspace_id");
    if (updateError) throw updateError;
    if (!claimed?.length) return null;
  }
  return { workspaceId, ownerId: workspace.ownerId, before, after };
}

/** A session that's doing nothing, whatever it last did: its activity, if
 *  it shows it working or waiting, set idle. */
async function settle(
  workspace: ReturnType<typeof toWorkspace>,
  activity: ActivityRow | null,
): Promise<ActivityChange | null> {
  if (!activity || (activity.turn === "idle" && !activity.waiting)) return null;
  const before = rowToTurn(activity);
  const after: TurnState = { ...before, turn: "idle", waiting: null, waitingToolId: null, waitingSince: null };
  // Only the row as read: a send that woke the box meanwhile (watchAfterSend's
  // "working") isn't undone, nor told as a turn that ended.
  const { data: settled, error } = await db()
    .from("session_activity")
    .update({ ...turnToRow(after), updated_at: new Date().toISOString() })
    .eq("workspace_id", workspace.id)
    .eq("updated_at", activity.updated_at)
    .select("workspace_id");
  if (error) throw error;
  if (!settled?.length) return null;
  // Cut off mid-turn: what it did since the last read may never be read, so
  // a Mission's spend says that stretch is unknown (docs/mission-spend.md).
  if (before.turn === "working") {
    await recordSessionGap(workspace, {
      box: activity.stream_box,
      cursor: Number(activity.stream_cursor ?? 0),
      at: activity.read_at,
    });
  }
  return { workspaceId: workspace.id, ownerId: workspace.ownerId, before, after };
}

/** The session's box, when it's up, and how to reach its agent; "down" when
 *  it's stopped (so is the agent); null when it can't be told, one still
 *  provisioning (reading never starts one). */
async function upBox(workspace: ReturnType<typeof toWorkspace>) {
  const filter = workspace.computerId
    ? `workspace_id.eq.${workspace.id},id.eq.${workspace.computerId}`
    : `workspace_id.eq.${workspace.id}`;
  const { data, error } = await db().from("runtime_computers").select("*").or(filter);
  if (error) throw error;
  const rows = data ?? [];
  const row = rows.find((r) => r.workspace_id === workspace.id) ?? rows[0];
  if (row && (row.status === "stopped" || row.status === "error")) return "down" as const;
  if (!row || row.status !== "ready" || !row.daytona_sandbox_id || !row.agent_secret) return null;
  const computer = toRuntimeComputer(row);
  const agentSecret = openAgentSecretOrNull(row.agent_secret, computer.id);
  if (!agentSecret) return null;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
  const target = await resolution.provider.agentTarget(computer.daytonaSandboxId!, agentSecret);
  return { target, sandboxId: computer.daytonaSandboxId!, computerId: computer.id };
}

/**
 * Something was just sent to the session (a prompt, an answer, secrets): it's
 * working, at once, for every client; then read closely until its turn ends
 * or it waits on you, and by the tick for a while after. `onChange` hears each
 * read that changed something.
 */
export async function watchAfterSend(
  workspaceId: string,
  ownerId: string,
  onChange?: (change: ActivityChange) => Promise<void>,
): Promise<void> {
  const now = Date.now();
  // A failed read mustn't pass for "never read": the insert below would then
  // collide with the row that's there.
  const { data: existing, error: readError } = await db()
    .from("session_activity")
    .select("turn, turn_started_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readError) throw readError;
  const startedAt = existing?.turn === "working" ? existing.turn_started_at : new Date(now).toISOString();
  const working = {
    turn: "working" as const,
    turn_started_at: startedAt,
    waiting: null,
    waiting_tool_id: null,
    waiting_since: null,
    watch_until: new Date(now + WATCH_FOR_MS).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  // An upsert, so a row made meanwhile (a tick's first read) is updated
  // rather than collided with.
  const { error } = await db()
    .from("session_activity")
    .upsert({ workspace_id: workspaceId, owner_id: ownerId, ...working }, { onConflict: "workspace_id" });
  if (error) throw error;

  const until = now + CLOSE_WATCH_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, CLOSE_WATCH_EVERY_MS));
    const change = await readSession(workspaceId).catch((readError: unknown) => {
      console.error(`Watch: couldn't read ${workspaceId}`, readError);
      return null;
    });
    if (change && onChange) await onChange(change).catch((hookError: unknown) => console.error(`Watch: ${workspaceId}'s change`, hookError));
    if (change && (change.after.turn === "idle" || change.after.waiting)) return;
  }
}

/** How many of the tick's reads go first to sessions still shown working or
 *  waiting, so ones whose box stopped mid-turn are settled however many
 *  boxes are up. */
const BUSY_FIRST = 25;

/** The sessions the tick reads: those still shown working or waiting (so one
 *  whose box stopped mid-turn is settled), longest unchanged first; then
 *  every one whose box is up, most recently active first; then those sent
 *  something lately. */
export async function watchedSessions(limit = 150): Promise<string[]> {
  const { data: live, error } = await db()
    .from("workspaces")
    .select("id, computer_id, last_active_at")
    .in("status", LIVE)
    .eq("background", false)
    .order("last_active_at", { ascending: false, nullsFirst: false })
    .limit(limit * 2);
  if (error) throw error;
  const ids = (live ?? []).map((w) => w.id);
  const computerIds = [...new Set((live ?? []).map((w) => w.computer_id).filter((id): id is string => Boolean(id)))];
  const [byWorkspace, byId, watched, busy] = await Promise.all([
    ids.length ? db().from("runtime_computers").select("workspace_id").eq("status", "ready").in("workspace_id", ids) : { data: [], error: null },
    computerIds.length ? db().from("runtime_computers").select("id").eq("status", "ready").in("id", computerIds) : { data: [], error: null },
    db().from("session_activity").select("workspace_id").gt("watch_until", new Date().toISOString()),
    db()
      .from("session_activity")
      .select("workspace_id")
      .or("turn.eq.working,waiting.not.is.null")
      .order("updated_at", { ascending: true })
      .limit(Math.min(BUSY_FIRST, limit)),
  ]);
  // A query that failed here would otherwise read as "nothing to read".
  if (byWorkspace.error) throw byWorkspace.error;
  if (byId.error) throw byId.error;
  if (watched.error) throw watched.error;
  if (busy.error) throw busy.error;
  const upOwn = new Set((byWorkspace.data ?? []).map((c) => c.workspace_id));
  const upShared = new Set((byId.data ?? []).map((c) => c.id));
  const up = (live ?? []).filter((w) => upOwn.has(w.id) || (w.computer_id && upShared.has(w.computer_id))).map((w) => w.id);
  const busyIds = (busy.data ?? []).map((a) => a.workspace_id);
  const watchedIds = (watched.data ?? []).map((a) => a.workspace_id);
  return [...new Set([...busyIds, ...up, ...watchedIds])].slice(0, limit);
}

/** watchAfterSend for a route's after(), telling the user what it sees
 *  (lib/notifications/record.ts): never fails the send. */
export async function watchSent(workspaceId: string, ownerId: string): Promise<void> {
  await watchAfterSend(workspaceId, ownerId, (change) => notifyActivity(change)).catch((error: unknown) =>
    console.error(`Watch: couldn't watch ${workspaceId} after a send`, error),
  );
}
