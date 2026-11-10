/**
 * A session's chats other than its main one (workspace_chats), through the
 * user's own client: the table's policy keeps each user to their own. A
 * database from before the table reads as none, so a session there has its
 * main chat alone.
 */

import { isAgentId } from "@/lib/agents/registry";
import { type RecordedModel, recordedModel } from "@/lib/runtime/session-models";
import { MAIN_CHAT, type SessionChat } from "@/lib/session/chats";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type ChatRow = Database["public"]["Tables"]["workspace_chats"]["Row"];

function toChat(row: ChatRow): SessionChat {
  return {
    id: row.id,
    name: row.name,
    agent: isAgentId(row.agent) ? row.agent : "claude",
    kind: row.kind === "side" ? "side" : "chat",
    forkedFrom: row.forked_from,
    model: recordedModel(row.model_provider, row.model_id, row.model_effort),
    createdAt: row.created_at,
  };
}

/** The session's chats other than its main one, oldest first. */
export async function listChats(workspaceId: string): Promise<SessionChat[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_chats")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  return data.map(toChat);
}

/** One of the session's chats other than its main one; null when it has no
 *  such chat. */
export async function getChat(workspaceId: string, chatId: string): Promise<SessionChat | null> {
  if (chatId === MAIN_CHAT) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_chats")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", chatId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
  if (error) throw error;
  return data ? toChat(data) : null;
}

/** Record a new chat; its id is the one the box runs it under. */
export async function insertChat(chat: {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  agent: SessionChat["agent"];
  kind: "chat" | "side";
  forkedFrom: string | null;
  model: RecordedModel | null;
}): Promise<SessionChat> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_chats")
    .insert({
      id: chat.id,
      workspace_id: chat.workspaceId,
      owner_id: chat.ownerId,
      name: chat.name,
      agent: chat.agent,
      kind: chat.kind,
      forked_from: chat.forkedFrom,
      model_provider: chat.model?.model.provider ?? null,
      model_id: chat.model?.model.id ?? null,
      model_effort: chat.model?.effort ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toChat(data);
}

/** Rename a chat: the main one's name is kept on its session's row, which
 *  only the server writes (20261106100000), so through the admin client. */
export async function renameChat(workspaceId: string, chatId: string, name: string): Promise<void> {
  const { error } =
    chatId === MAIN_CHAT
      ? await createSupabaseAdminClient().from("workspaces").update({ main_chat_name: name }).eq("id", workspaceId)
      : await (await createSupabaseServerClient())
          .from("workspace_chats")
          .update({ name })
          .eq("workspace_id", workspaceId)
          .eq("id", chatId);
  if (error) throw error;
}

/** Forget a chat other than the main one. */
export async function deleteChatRow(workspaceId: string, chatId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("workspace_chats").delete().eq("workspace_id", workspaceId).eq("id", chatId);
  if (error) throw error;
}

/** Record the model a chat was just put on, so it relaunches on it. Best
 *  effort, as recordWorkspaceModel. */
export async function recordChatModel(workspaceId: string, chatId: string, recorded: RecordedModel): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workspace_chats")
    .update({ model_provider: recorded.model.provider, model_id: recorded.model.id, model_effort: recorded.effort })
    .eq("workspace_id", workspaceId)
    .eq("id", chatId);
  if (error) console.warn(`Chat ${chatId}: could not record its model ${recorded.model.provider}/${recorded.model.id}`, error);
}

/** A session's chats other than its main one, as the server reads them (an
 *  archive, which an automation's run makes too, with no user signed in);
 *  the caller has the session's owner's say already. */
export async function listChatsOf(workspaceId: string): Promise<SessionChat[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("workspace_chats")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error && probeStatus(error) === "missing") return [];
  if (error) throw error;
  return data.map(toChat);
}
