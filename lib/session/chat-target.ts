/**
 * The chat a request to a session's route names (`?chat=`): its main chat
 * when none is named, as every caller from before chats expects (a Mission,
 * Slack, the API); else one of its others, by its row. Server-only.
 */

import { NextResponse } from "next/server";

import { getChat } from "@/lib/db/chats";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import type { Workspace } from "@/lib/runtime/types";
import { MAIN_CHAT, mainChatOf, parseChatId, type SessionChat } from "@/lib/session/chats";

/** The chat `request`'s `?chat=` names in `workspace`, or the response saying
 *  why there is none: an id that can't be one, or a chat it doesn't have. */
export async function requestedChat(
  request: Request,
  workspace: Workspace,
): Promise<{ ok: true; chat: SessionChat } | { ok: false; response: NextResponse }> {
  return chatNamed(new URL(request.url).searchParams.get("chat"), workspace);
}

/** requestedChat for an id given another way (an API body's chat_id). */
export async function chatNamed(
  value: unknown,
  workspace: Workspace,
): Promise<{ ok: true; chat: SessionChat } | { ok: false; response: NextResponse }> {
  const id = parseChatId(value);
  if (id === null) return { ok: false, response: NextResponse.json({ error: "That isn't a chat's id." }, { status: 400 }) };
  if (id === MAIN_CHAT) return { ok: true, chat: mainChatOf(workspace) };
  const chat = await getChat(workspace.id, id);
  if (!chat) return { ok: false, response: NextResponse.json({ error: "This session has no such chat." }, { status: 404 }) };
  return { ok: true, chat };
}

/** The `chat` the agent client takes for a chat: none for the main one, so
 *  an agent from before chats is asked as it always was. */
export function agentChat(chat: SessionChat): string | undefined {
  return chat.id === MAIN_CHAT ? undefined : chat.id;
}

/** Whether the agent said it has no such chat: a box that lost it (a
 *  restore onto a new box), or one from before chats (no route at all). */
export function chatMissingOnBox(error: unknown): boolean {
  return error instanceof AgentRequestError && error.status === 404 && (error.error?.code === "CHAT_NOT_FOUND" || !error.error);
}
