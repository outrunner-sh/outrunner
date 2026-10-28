/**
 * A Slack thread's research: questions about the code itself, answered by a
 * session of the thread's own that runs out of sight (workspaces.background).
 *
 * The first question starts it, as the person asking, on the repository the
 * agent named; it reads the code and posts its answer back through a
 * one-time link (POST /api/integrations/slack/research/:id). When the thread
 * goes quiet its box is paused like any idle session's; the thread's next
 * question resumes it, so it answers with what it already found. One per
 * thread and asker: threads never share what they asked, and a session only
 * has what its asker may read.
 */

import { randomBytes } from "node:crypto";

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { POST as messagePOST } from "@/app/api/workspaces/[id]/message/route";
import { getWorkspace } from "@/lib/db/repositories";
import {
  getInstallation,
  sessionSummary,
  type SlackConversation,
  type SlackInstallation,
  updateConversation,
} from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { startServerSession } from "@/lib/session/server-session";
import { FROM_HEADER, type MessageSource } from "@/lib/slack/from";
import { hashToken, markdownToSlack, researchPrompt, slackChunks } from "@/lib/slack/research-text";
import { postMessage } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { actAsUser } from "@/lib/supabase/acting-user";
import type { TriageActor } from "@/lib/triage/access";

const RESUMABLE = new Set(["ready", "idle", "suspended", "archived"]);

function base(): string {
  return optionalEnv("RUNTIME_BASE_URL") ?? "";
}

/** A route of the app's, called as the user (inside actAsUser), as the
 *  browser would: same origin, JSON. */
export function asBrowser(path: string, body: unknown, from?: MessageSource): Request {
  return new Request(new URL(path, base()), {
    method: "POST",
    headers: {
      origin: new URL(base()).origin,
      "content-type": "application/json",
      // Said in Slack or on GitHub already: not echoed to Slack as the
      // owner's (lib/slack/relay.ts).
      ...(from && { [FROM_HEADER]: from }),
    },
    body: JSON.stringify(body),
  });
}


/**
 * Send a prompt to one of `userId`'s sessions, waking it first if its box was
 * paused, or restoring it if it was archived: the same lifecycle and message
 * routes the session page uses. False
 * when it can't be (gone, or not answering): the caller starts a
 * new one.
 */
export async function wakeAndSend(userId: string, workspaceId: string, prompt: string, from?: MessageSource): Promise<boolean> {
  return actAsUser(userId, async () => {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace || workspace.ownerId !== userId || !RESUMABLE.has(workspace.status)) return false;
    const params = { params: Promise.resolve({ id: workspaceId }) };
    // Paused: resumed. Archived: restored, as opening it in the app does.
    if (workspace.status === "suspended" || workspace.status === "archived") {
      const action = workspace.status === "suspended" ? "resume" : "restore";
      const woken = await lifecyclePOST(asBrowser(`/api/workspaces/${workspaceId}/lifecycle`, { action }), params);
      if (!woken.ok) return false;
    }
    const sent = await messagePOST(asBrowser(`/api/workspaces/${workspaceId}/message`, { content: prompt }, from), params);
    return sent.ok;
  });
}

/**
 * Put a question to the thread's research session, as `asker`: the one they
 * have on this repository, woken; or a new one. The thread is told if it
 * can't start; the answer comes from the session itself.
 */
export async function askResearch(input: {
  install: SlackInstallation;
  conversation: SlackConversation;
  asker: TriageActor;
  projectId: string;
  question: string;
}): Promise<void> {
  const { install, conversation, asker, projectId, question } = input;
  const where = { channel: conversation.channelId, threadTs: conversation.threadTs };
  const say = (text: string) => postMessage(install.botToken, { ...where, text });

  const token = randomBytes(32).toString("base64url");
  const db = createSupabaseAdminClient();
  const { data: research, error } = await db
    .from("slack_research")
    .insert({ conversation_id: conversation.id, asked_by: asker.userId, question, token_hash: hashToken(token) })
    .select("id")
    .single();
  if (error) throw error;
  const url = new URL(`/api/integrations/slack/research/${research.id}`, base()).toString();
  const prompt = researchPrompt({ question, url, token });

  // The thread's session, if it's this asker's and on this repository.
  const existing = conversation.researchWorkspaceId ? await sessionSummary(conversation.researchWorkspaceId).catch(() => null) : null;
  if (existing && existing.ownerId === asker.userId && existing.projectId === projectId) {
    if (await wakeAndSend(asker.userId, existing.id, prompt).catch(() => false)) {
      await db.from("slack_research").update({ workspace_id: existing.id }).eq("id", research.id);
      return;
    }
  }

  const result = await startServerSession({
    userId: asker.userId,
    projectId,
    title: `Slack research: ${question.slice(0, 80)}`,
    prompt,
    onCreated: async (workspaceId) => {
      // Out of sight from the start: it isn't one of the asker's sessions.
      await db.from("workspaces").update({ background: true }).eq("id", workspaceId);
      await db.from("slack_research").update({ workspace_id: workspaceId }).eq("id", research.id);
      await updateConversation(conversation.id, { researchWorkspaceId: workspaceId });
    },
  });
  if (result.status !== "ready") {
    await db.from("slack_research").update({ status: "failed" }).eq("id", research.id);
    await say(`I couldn't start looking into that: ${result.errorMessage ?? "the session didn't start"}.`);
  }
}

/**
 * The research session's answer, through its link: posted in the thread,
 * once. False for a link that isn't one, or was used.
 */
export async function answerResearch(id: string, token: string, answer: string): Promise<boolean> {
  const db = createSupabaseAdminClient();
  // Claimed in one step, so a second post of the same link finds it used.
  const { data: claimed, error } = await db
    .from("slack_research")
    .update({ status: "answered", answered_at: new Date().toISOString() })
    .eq("id", id)
    .eq("token_hash", hashToken(token))
    .eq("status", "asked")
    .select("conversation_id")
    .maybeSingle();
  if (error) throw error;
  if (!claimed) return false;
  const { data: conversation } = await db
    .from("slack_conversations")
    .select("team_id, channel_id, thread_ts")
    .eq("id", claimed.conversation_id)
    .maybeSingle();
  if (!conversation) return true;
  try {
    const install = await getInstallation(conversation.team_id);
    if (!install) return true;
    for (const chunk of slackChunks(markdownToSlack(answer))) {
      await postMessage(install.botToken, { channel: conversation.channel_id, threadTs: conversation.thread_ts, text: chunk });
    }
  } catch (error) {
    // The link is used either way: the session isn't asked to post again.
    console.error(`Slack agent: couldn't post research ${id}'s answer`, error);
  }
  return true;
}
