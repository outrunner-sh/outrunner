/**
 * A session's chats: its main chat, which is the session itself (everything
 * that names no chat reaches it: a Mission, Slack, the API), and the others
 * made in it, each a conversation of its own on its own agent and model in
 * the session's worktree (runtime-agent/internal/workspace/chats.go). Their
 * record is workspace_chats; the main chat's is the session's row.
 *
 * Pure (no React, no database), so it is unit-tested in Node.
 */

import type { AgentId } from "@/lib/agents/registry";
import { MAIN_CHAT } from "@/lib/runtime/agent-protocol";
import type { RecordedModel } from "@/lib/runtime/session-models";

export { MAIN_CHAT };

/** A chat as the page and the API show it. */
export type SessionChat = {
  /** MAIN_CHAT for the session's own, else its row's id. */
  id: string;
  name: string;
  agent: AgentId;
  /** The main chat, a chat, or a side chat (/btw). */
  kind: "main" | "chat" | "side";
  /** The chat a fork continues: MAIN_CHAT or another chat's id. */
  forkedFrom: string | null;
  /** The model it was last put on; for the main chat, the session's. */
  model: RecordedModel | null;
  createdAt: string;
};

/** What a main chat is called until it is renamed. */
export const MAIN_CHAT_NAME = "Main";

/** The longest name a chat takes (workspace_chats.name). */
export const CHAT_NAME_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A chat id as a request or a URL gives it: MAIN_CHAT, a chat's UUID, or
 *  null for anything else. None given is the main chat. */
export function parseChatId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return MAIN_CHAT;
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return id === MAIN_CHAT || UUID.test(id) ? id : null;
}

/** A name as the user typed it, trimmed and on one line; null when there is
 *  nothing left, or too much. */
export function chatName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= CHAT_NAME_MAX ? name : null;
}

/** The session's main chat, from its row. */
export function mainChatOf(workspace: {
  agent: AgentId;
  model: RecordedModel | null;
  mainChatName?: string | null;
  createdAt: string;
}): SessionChat {
  return {
    id: MAIN_CHAT,
    name: workspace.mainChatName || MAIN_CHAT_NAME,
    agent: workspace.agent,
    kind: "main",
    forkedFrom: null,
    model: workspace.model,
    createdAt: workspace.createdAt,
  };
}

/** What a new chat is called before the user names it: the next "Chat n"
 *  for a chat, "Fork of <name>" for a fork, "Side: <question>" for a side
 *  chat, cut to fit. */
export function defaultChatName(
  existing: { name: string }[],
  how: { from?: { name: string }; side?: boolean; question?: string } = {},
): string {
  const fit = (name: string) => (name.length > CHAT_NAME_MAX ? `${name.slice(0, CHAT_NAME_MAX - 1).trimEnd()}…` : name);
  if (how.side) {
    const question = how.question?.replace(/\s+/g, " ").trim();
    return fit(question ? `Side: ${question}` : `Side chat about ${how.from?.name ?? MAIN_CHAT_NAME}`);
  }
  if (how.from) return fit(`Fork of ${how.from.name}`);
  const taken = new Set(existing.map((chat) => chat.name));
  for (let n = existing.length + 1; ; n++) {
    if (!taken.has(`Chat ${n}`)) return `Chat ${n}`;
  }
}

/** The chats in the order the switcher lists them: the main chat first, then
 *  the others oldest first. */
export function orderedChats(main: SessionChat, others: SessionChat[]): SessionChat[] {
  return [main, ...[...others].sort((a, b) => a.createdAt.localeCompare(b.createdAt))];
}

/** Where a chat's page state is kept (its conversation, queue, mode): the
 *  session's own key for the main chat, so what a tab kept before chats is
 *  still the main chat's. */
export function chatStateKey(workspaceId: string, chatId: string): string {
  return chatId === MAIN_CHAT ? workspaceId : `${workspaceId}:${chatId}`;
}

/** A session route of Outrunner's for one of its chats: the route as it was
 *  for the main chat, `?chat=` added for any other. */
export function chatRoute(workspaceId: string, chatId: string, route: string): string {
  const path = `/api/workspaces/${workspaceId}/${route}`;
  if (chatId === MAIN_CHAT) return path;
  return `${path}${path.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chatId)}`;
}

/** What the runtime-agent sends a chat's prompt with (chats.go), wrapped in
 *  tags: a fork's handoff, and a side chat's context. */
const CARRIED = [
  { kind: "handoff", pattern: /<outrunner-handoff>[\s\S]*?<\/outrunner-handoff>\s*/g },
  { kind: "side", pattern: /<outrunner-side-chat>[\s\S]*?<\/outrunner-side-chat>\s*/g },
] as const;

/** A prompt as the user wrote it, without what it was sent with, and what
 *  that was: the timeline shows the words, and the rest folded away. */
export function withoutCarried(text: string): { text: string; carried: ("handoff" | "side")[] } {
  const carried: ("handoff" | "side")[] = [];
  let rest = text;
  for (const { kind, pattern } of CARRIED) {
    const next = rest.replace(pattern, "");
    if (next !== rest) carried.push(kind);
    rest = next;
  }
  return { text: carried.length > 0 ? rest.trim() : text, carried };
}

/** A list fetched before a local create must not erase the newly created chat. */
export function mergeChatList(listed: SessionChat[], known: SessionChat[]): SessionChat[] {
  const ids = new Set(listed.map((chat) => chat.id));
  return [...listed, ...known.filter((chat) => !ids.has(chat.id))];
}
