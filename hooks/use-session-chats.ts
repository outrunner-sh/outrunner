"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentId } from "@/lib/agents/registry";
import { requestJson } from "@/lib/http/request-json";
import { mergeChatList, MAIN_CHAT, type SessionChat } from "@/lib/session/chats";

/** How a new chat starts: afresh, a fork of one (`from`), or a side chat
 *  about one (`side`), on an agent of its own (`agent`, else its source's). */
export type NewChat = { agent?: AgentId; from?: string; side?: boolean; question?: string };

export type SessionChats = {
  /** The session's chats, its main one first; just the main one until read. */
  chats: SessionChat[];
  loaded: boolean;
  error: string | null;
  reportError: (message: string) => void;
  isCurrent: () => boolean;
  start: (how: NewChat) => Promise<SessionChat>;
  rename: (chatId: string, name: string) => Promise<void>;
  remove: (chatId: string) => Promise<void>;
};

/**
 * A cloud session's chats (app/api/workspaces/[id]/chats), read as the page
 * opens and kept in step with what it changes. `main` stands in for the list
 * until it is read, and for a session that can't have others (a local one,
 * `enabled` false).
 */
export function useSessionChats(workspaceId: string, main: SessionChat, enabled: boolean): SessionChats {
  const [loadedWorkspace, setLoadedWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [others, setOthers] = useState<SessionChat[]>([]);
  const [mainName, setMainName] = useState<string | null>(null);

  const [stateWorkspace, setStateWorkspace] = useState(workspaceId);
  if (stateWorkspace !== workspaceId) {
    setStateWorkspace(workspaceId);
    setOthers([]);
    setMainName(null);
    setError(null);
  }

  const shown = useRef<string | null>(workspaceId);
  useEffect(() => {
    shown.current = workspaceId;
    return () => { shown.current = null; };
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    requestJson<{ chats: SessionChat[] }>(`/api/workspaces/${workspaceId}/chats`, { has: (d) => Array.isArray(d.chats) })
      .then(({ chats }) => {
        if (!live) return;
        setError(null);
        setOthers((known) => mergeChatList(chats.filter((chat) => chat.id !== MAIN_CHAT), known));
        setMainName(chats.find((chat) => chat.id === MAIN_CHAT)?.name ?? null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        console.warn(`Chats: couldn't list ${workspaceId}'s`, error);
        setError("Couldn't load this session's chats. Reload to try again.");
      })
      .finally(() => { if (live) setLoadedWorkspace(workspaceId); });
    return () => {
      live = false;
    };
  }, [workspaceId, enabled]);

  const start = useCallback(
    async (how: NewChat) => {
      const { chat } = await requestJson<{ chat: SessionChat }>(`/api/workspaces/${workspaceId}/chats`, {
        method: "POST",
        body: how,
        has: (d) => typeof d.chat?.id === "string",
        fallback: "Couldn't start the chat. Try again.",
      });
      if (shown.current !== workspaceId) throw new Error("The session changed before the chat was ready.");
      setOthers((chats) => [...chats, chat]);
      return chat;
    },
    [workspaceId],
  );

  const rename = useCallback(
    async (chatId: string, name: string) => {
      await requestJson(`/api/workspaces/${workspaceId}/chats/${chatId}`, {
        method: "PATCH",
        body: { name },
        fallback: "Couldn't rename the chat. Try again.",
      });
      if (shown.current !== workspaceId) return;
      if (chatId === MAIN_CHAT) setMainName(name);
      else setOthers((chats) => chats.map((chat) => (chat.id === chatId ? { ...chat, name } : chat)));
    },
    [workspaceId],
  );

  const remove = useCallback(
    async (chatId: string) => {
      await requestJson(`/api/workspaces/${workspaceId}/chats/${chatId}`, {
        method: "DELETE",
        fallback: "Couldn't delete the chat. Try again.",
      });
      if (shown.current !== workspaceId) return;
      setOthers((chats) => chats.filter((chat) => chat.id !== chatId));
    },
    [workspaceId],
  );

  return { loaded: !enabled || loadedWorkspace === workspaceId, error, isCurrent: () => shown.current === workspaceId, reportError: (message) => { if (shown.current === workspaceId) setError(message); }, chats: [mainName ? { ...main, name: mainName } : main, ...others], start, rename, remove };
}
