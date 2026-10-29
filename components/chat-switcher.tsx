"use client";

import { Check, ChevronsUpDown, GitFork, MessageCircleQuestionMark, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/loaders";
import type { NewChat, SessionChats } from "@/hooks/use-session-chats";
import { AGENT_IDS, AGENTS, type AgentId } from "@/lib/agents/registry";
import { CHAT_NAME_MAX, MAIN_CHAT, type SessionChat } from "@/lib/session/chats";

/**
 * The chats of a session, beside its title: the one shown, opening onto the
 * others to switch to, each renamed or deleted from its row, and a new chat
 * or a fork of the one shown, on either agent. `+` starts a new chat on the
 * shown one's agent at once.
 */
export function ChatSwitcher({
  chats,
  current,
  agents,
  onPick,
}: {
  chats: SessionChats;
  current: SessionChat;
  /** The agents the session's box runs: a new chat may be on any of them. */
  agents: AgentId[];
  onPick: (chat: SessionChat) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionChat | null>(null);
  const [name, setName] = useState("");

  const act = async (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const start = (how: NewChat) => act(async () => onPick(await chats.start(how)));
  const offered = AGENT_IDS.filter((id) => agents.includes(id));
  const sourceOf = (chat: SessionChat) => chats.chats.find((c) => c.id === chat.forkedFrom);

  return (
    <div className="studio-chats">
      {renaming ? (
        <form
          className="studio-chat-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const chat = renaming;
            setRenaming(null);
            if (name.trim() && name.trim() !== chat.name) void act(() => chats.rename(chat.id, name.trim()));
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={CHAT_NAME_MAX}
            aria-label="Chat name"
            onChange={(event) => setName(event.target.value)}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(null);
            }}
          />
        </form>
      ) : (
        <DropdownMenu onOpenChange={(open) => open && setError(null)}>
          <DropdownMenuTrigger className="studio-chat-trigger" aria-label={`Chat: ${current.name}. Switch chat`} title={current.name}>
            {busy ? <Spinner /> : <ChatIcon chat={current} />}
            <span className="min-w-0 truncate">{current.name}</span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Chats in this session</DropdownMenuLabel>
            {chats.chats.map((chat) => (
              <DropdownMenuItem key={chat.id} onSelect={() => onPick(chat)} className="group gap-2">
                <ChatIcon chat={chat} />
                <span className="min-w-0 flex-1 truncate" title={sourceOf(chat) ? `Forked from ${sourceOf(chat)?.name}` : chat.name}>
                  {chat.name}
                </span>
                <span className="text-xs text-muted-foreground">{AGENTS[chat.agent].label}</span>
                <span className="studio-chat-row-actions">
                  <button
                    type="button"
                    title="Rename"
                    aria-label={`Rename ${chat.name}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setName(chat.name);
                      setRenaming(chat);
                    }}
                  >
                    <Pencil aria-hidden />
                  </button>
                  {chat.id !== MAIN_CHAT && (
                    <button
                      type="button"
                      title="Delete: stops its turn"
                      aria-label={`Delete ${chat.name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!window.confirm(`Delete "${chat.name}"? Its agent stops; the session and its other chats carry on.`)) return;
                        void act(async () => {
                          await chats.remove(chat.id);
                          if (chat.id === current.id) onPick(chats.chats[0]);
                        });
                      }}
                    >
                      <Trash2 aria-hidden />
                    </button>
                  )}
                </span>
                {chat.id === current.id ? <Check aria-hidden className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <NewChatItems label="New chat" icon={<Plus className="size-4" />} agents={offered} onStart={(agent) => start({ agent })} />
            <NewChatItems
              label="Fork this chat"
              icon={<GitFork className="size-4" />}
              agents={offered}
              onStart={(agent) => start({ agent, from: current.id })}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        className="studio-icon-button"
        disabled={busy}
        onClick={() => void start({ agent: current.agent })}
        title={`New chat on ${AGENTS[current.agent].label}, in this session's worktree`}
        aria-label="New chat"
      >
        <Plus />
      </button>
      {error && (
        <p role="alert" className="studio-chat-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A way to start a chat: on one agent, or a choice of them. */
function NewChatItems({
  label,
  icon,
  agents,
  onStart,
}: {
  label: string;
  icon: React.ReactNode;
  agents: AgentId[];
  onStart: (agent: AgentId) => void;
}) {
  if (agents.length <= 1) {
    return (
      <DropdownMenuItem className="gap-2" onSelect={() => onStart(agents[0] ?? "claude")}>
        {icon} {label}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        {icon} {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent} onSelect={() => onStart(agent)}>
            On {AGENTS[agent].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ChatIcon({ chat }: { chat: SessionChat }) {
  if (chat.kind === "side") return <MessageCircleQuestionMark aria-label="Side chat" className="size-3.5 shrink-0 text-muted-foreground" />;
  if (chat.forkedFrom) return <GitFork aria-label="Forked" className="size-3.5 shrink-0 text-muted-foreground" />;
  return null;
}
