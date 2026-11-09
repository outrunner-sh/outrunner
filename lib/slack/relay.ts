/**
 * A Slack thread and its session in step (Replicas' way), while the session's
 * sync is on (workspaces.slack_sync):
 *
 *   thread → session  what people say in the thread is sent to the session
 *                     (woken or restored first), with who said it
 *   session → thread  each turn's reply: once the session has gone quiet
 *                     after something was sent, its last message is posted,
 *                     once (relayed_hash)
 *
 * The reply is watched for right after a send (watchForReply, in after()),
 * and by the cron's tick for as long as one is awaited (relay_until), for
 * turns that outlast the watch.
 */

import { GET as summaryGET } from "@/app/api/workspaces/[id]/summary/route";
import { POST as interruptPOST } from "@/app/api/workspaces/[id]/interrupt/route";
import { conversationForWorkspace, getConversationById, getInstallation, type SlackConversation } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { asBrowser, wakeAndSend } from "@/lib/slack/research";
import { markdownToSlack, slackChunks } from "@/lib/slack/research-text";
import { fromThread, replyChunks } from "@/lib/slack/relay-text";
import { relayTurn } from "@/lib/session/turn-relay";
import { watchUntil } from "@/lib/session/turn-watch";
import { addReaction, postMessage } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { actAsUser } from "@/lib/supabase/acting-user";

/** How long a reply is waited for after a send. */
const AWAIT_MS = 2 * 60 * 60_000;
/** How long the send's own watch lasts before the tick takes over. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 10_000;

type Summary = { lastAssistantMessage: string | null; lastActivity: string; state: string };

function db() {
  return createSupabaseAdminClient();
}

function sessionUrl(workspaceId: string): string {
  const base = optionalEnv("RUNTIME_BASE_URL");
  try {
    return base ? new URL(`/workspaces/${workspaceId}`, base).toString() : `/workspaces/${workspaceId}`;
  } catch {
    return `/workspaces/${workspaceId}`;
  }
}

async function session(workspaceId: string): Promise<{ ownerId: string; sync: boolean; status: string } | null> {
  const { data, error } = await db()
    .from("workspaces")
    .select("owner_id, slack_sync, status")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? { ownerId: data.owner_id, sync: data.slack_sync, status: data.status } : null;
}

/**
 * Send something said in the thread to the thread's session, and await its
 * reply. False when the session can't take it (sync off, gone, or not
 * answering).
 */
export async function sendToSession(conversation: SlackConversation, text: string): Promise<boolean> {
  if (!conversation.workspaceId) return false;
  const target = await session(conversation.workspaceId);
  if (!target || !target.sync) return false;
  const sent = await wakeAndSend(target.ownerId, conversation.workspaceId, text, "slack").catch(() => false);
  if (sent) await awaitReply(conversation.id);
  return sent;
}

/** A reply is due from the session: the tick looks for it until AWAIT_MS. */
export async function awaitReply(conversationId: string): Promise<void> {
  await db()
    .from("slack_conversations")
    .update({ relay_until: new Date(Date.now() + AWAIT_MS).toISOString() })
    .eq("id", conversationId);
}

/** Stop the session's turn (`@Outrunner stop`). */
export async function stopSession(conversation: SlackConversation): Promise<boolean> {
  if (!conversation.workspaceId) return false;
  const target = await session(conversation.workspaceId);
  if (!target) return false;
  const workspaceId = conversation.workspaceId;
  return actAsUser(target.ownerId, async () => {
    const response = await interruptPOST(asBrowser(`/api/workspaces/${workspaceId}/interrupt`, {}), {
      params: Promise.resolve({ id: workspaceId }),
    });
    return response.ok;
  }).catch(() => false);
}

async function readSummary(ownerId: string, workspaceId: string): Promise<Summary | null> {
  return actAsUser(ownerId, async () => {
    const response = await summaryGET(new Request(new URL(`/api/workspaces/${workspaceId}/summary`, optionalEnv("RUNTIME_BASE_URL") ?? "http://localhost")), {
      params: Promise.resolve({ id: workspaceId }),
    });
    return response.ok ? ((await response.json()) as Summary) : null;
  }).catch(() => null);
}

/**
 * Post the session's reply in the thread, if its turn is over and this reply
 * hasn't been posted. True when it was (or there's nothing left to wait for);
 * false to keep waiting.
 */
export async function relayReply(conversation: SlackConversation): Promise<boolean> {
  const workspaceId = conversation.workspaceId;
  if (!workspaceId) return true;
  const target = await session(workspaceId);
  if (!target || !target.sync) return true;
  return relayTurn(
    {
      load: async () => {
        const { data, error } = await db()
          .from("slack_conversations")
          .select("relayed_hash, relay_until")
          .eq("id", conversation.id)
          .maybeSingle();
        if (error) throw error;
        return { relayedHash: data?.relayed_hash ?? null, relayUntil: data?.relay_until ?? null };
      },
      summary: () => readSummary(target.ownerId, workspaceId),
      claim: async (digest) => {
        const { data, error } = await db()
          .from("slack_conversations")
          .update({ relayed_hash: digest, relay_until: null })
          .eq("id", conversation.id)
          .or(`relayed_hash.is.null,relayed_hash.neq.${digest}`)
          .select("id");
        if (error) throw error;
        return (data ?? []).length > 0;
      },
      clear: async () => {
        await db().from("slack_conversations").update({ relay_until: null }).eq("id", conversation.id);
      },
      restore: async (previous) => {
        await db()
          .from("slack_conversations")
          .update({ relayed_hash: previous.relayedHash, relay_until: previous.relayUntil })
          .eq("id", conversation.id);
      },
      post: async (message) => {
        const install = await getInstallation(conversation.teamId);
        if (!install) return;
        for (const text of replyChunks(message, sessionUrl(workspaceId))) {
          await postMessage(install.botToken, { channel: conversation.channelId, threadTs: conversation.threadTs, text });
        }
        if (/\/pull\/\d+/.test(message)) {
          await addReaction(install.botToken, { channel: conversation.channelId, ts: conversation.threadTs, name: "white_check_mark" }).catch(
            () => undefined,
          );
        }
      },
    },
    AWAIT_MS,
  );
}

/** Watch for the reply to what was just sent, for a while; the tick carries
 *  on after. */
export async function watchForReply(conversation: SlackConversation): Promise<void> {
  await watchUntil(() => relayReply(conversation), { forMs: WATCH_MS, everyMs: WATCH_EVERY_MS });
}

/**
 * Something typed in the app to a session started from Slack, while its sync
 * is on: posted in the thread, with who said it, and its reply awaited there
 * too (as Devin's sync and Replicas' "Send & post to Slack" do).
 */
export async function echoToThread(workspaceId: string, author: string, text: string): Promise<void> {
  const conversation = await conversationForWorkspace(workspaceId);
  if (!conversation) return;
  const target = await session(workspaceId);
  if (!target?.sync) return;
  const install = await getInstallation(conversation.teamId);
  if (!install) return;
  for (const chunk of slackChunks(markdownToSlack(`*${author}* (in Outrunner): ${text.trim()}`), 3500)) {
    await postMessage(install.botToken, { channel: conversation.channelId, threadTs: conversation.threadTs, text: chunk });
  }
  await awaitReply(conversation.id);
  await watchForReply(conversation);
}

/** The tick's part: replies still awaited. */
export async function relayAwaited(limit = 20): Promise<number> {
  const { data, error } = await db()
    .from("slack_conversations")
    .select("id")
    .not("relay_until", "is", null)
    .gt("relay_until", new Date().toISOString())
    .limit(limit);
  if (error) throw error;
  let posted = 0;
  for (const row of data ?? []) {
    const conversation = await getConversationById(row.id);
    if (conversation && (await relayReply(conversation).catch(() => false))) posted++;
  }
  return posted;
}

export { fromThread };
