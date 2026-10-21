"use client";

import "@xterm/xterm/css/xterm.css";

import { ChevronRight, RefreshCw, TerminalSquare, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { ConversationTimeline, claudeIsWorking } from "@/components/conversation-timeline";
import { SessionComposer, type ModelChoice } from "@/components/session-composer";
import { deliverLocalAgentAuth } from "@/lib/desktop/local-agent-auth";
import { localAgentRequest, localTarget, messageForLocalError, putOnModel } from "@/lib/desktop/local-runtime";
import { firstUserPrompt, userPromptCount } from "@/lib/runtime/conversation-events";
import {
  anchorPending,
  livePrompts,
  pendingShows,
  type PendingPrompt,
} from "@/lib/session/optimistic-echo";
import { conversationPlaceholder } from "@/lib/session/conversation-placeholder";
import {
  forgetFirstPrompt,
  hasFirstPrompt,
  rememberedFirstPrompt,
  sendFirstPromptOnce,
  tabStorage,
  withoutFirstPrompt,
  type FirstPrompt,
} from "@/lib/session/first-prompt";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { isProviderId } from "@/lib/providers/registry";
import { EMPTY_LOADOUT } from "@/lib/runtime/model-loadout";
import {
  defaultModel,
  type Effort,
  modelGroups,
  type ModelProvider,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";
import { rememberedEffort, rememberEffort } from "@/lib/session/picked-effort";
import type { OutrunnerModels } from "@/lib/desktop/local-runtime";
import { useOutrunnerModels } from "@/hooks/use-outrunner-models";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useSessionTerminal } from "@/hooks/use-session-terminal";
import { cn } from "@/lib/utils";

const MENU_UNTIL_ANSWERED: OutrunnerModels = {
  outrunner: true,
  allowance: false,
  keys: [],
  available: true,
  loadout: EMPTY_LOADOUT,
};

export function WorkspaceSession({
  workspaceId,
  agent = "claude",
  local = false,
  showTerminal,
  onToggleTerminal,
  terminalSlot,
  untitled = false,
  initialPrompt,
  initialAttachmentIds,
}: {
  workspaceId: string;
  /** The coding agent the session runs: its model menu offers only models
   *  that agent runs. */
  agent?: AgentId;
  /** A local session: everything then goes through the Outrunner app to the
   *  agent on this Mac, instead of through the server. */
  local?: boolean;
  /** Whether the collapsible live terminal is revealed (owned by the studio). */
  showTerminal: boolean;
  onToggleTerminal: () => void;
  /** Where the terminal docks: the bottom of the studio's Environment panel.
   *  The terminal shares this session's attachment, so it is rendered here
   *  and portalled there; null until the panel has mounted. */
  terminalSlot: HTMLElement | null;
  /** A cloud session with no title yet, which takes one from the first prompt
   *  in its history (sessions from before titles were saved). */
  untitled?: boolean;
  /** First prompt to send once the session accepts input (from /new). */
  initialPrompt?: string;
  /** Attachment ids from the home composer, delivered with the first prompt. */
  initialAttachmentIds?: string[];
}) {
  const router = useRouter();
  const [terminalContainer, setTerminalContainer] = useState<HTMLDivElement | null>(null);
  const attachment = useSessionAttachment(workspaceId, local, agent);
  const terminal = useSessionTerminal(attachment, terminalContainer, showTerminal);
  const conversation = useConversationStream(attachment, workspaceId);

  // The jcode engine has no PTY: prompts go over the /message API and the reply
  // streams back on the Conversation SSE. So input readiness and errors come
  // from the session attachment + conversation stream, not the terminal (which
  // stays available only as an optional shell panel).
  const [sendError, setSendError] = useState<string | null>(null);
  // A broken connection outranks a failed send: reconnecting is the way out of
  // it. A failed send or model switch is only dismissed — the composer already
  // has the prompt back to send again.
  const connectionError = conversation.error ?? attachment.error;
  const error = connectionError ?? sendError;
  const refresh = () => {
    setSendError(null);
    attachment.refresh();
  };
  const attached = attachment.status === "attached";
  // The composer takes a prompt while the session is still connecting: it goes
  // once attached (whenAttached), so opening a session never means waiting to
  // type. Only a failed attach stops it, until Reconnect.
  const canSend = attachment.status !== "error";
  const whenAttached = useWhenAttached(attachment.status, connectionError);

  // Optimistic echo: the prompt only reaches the timeline after Claude logs it
  // and the agent streams it back (a second or two). Show the user's own bubble
  // immediately and drop it once the streamed copy of that turn arrives, so the
  // composer feels instant without ever double-rendering the message.
  // Which bubble is superseded when is lib/session/optimistic-echo.ts: a
  // delivered-prompt count rather than the text, anchored as the session takes
  // the prompt rather than as it is typed.
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  // The newest events, for anchoring after an await, when the closure's are old.
  const eventsRef = useRef(conversation.events);
  useEffect(() => {
    eventsRef.current = conversation.events;
  }, [conversation.events]);

  /** The prompt has reached the session: hold its bubble until the stream has
   *  recorded one more prompt than the history it answered with. */
  const anchor = (pendingId: string) =>
    setPending((prev) => anchorPending(prev, pendingId, userPromptCount(eventsRef.current)));

  const send = (text: string, attachmentIds: string[] = []) => {
    const trimmed = text.trim();
    const pendingId = crypto.randomUUID();
    if (trimmed) {
      setPending((prev) => {
        // Drop items the stream has already caught up on, then queue this one.
        // Trimming here (not in an effect) keeps the list bounded without a
        // setState-in-effect cascade.
        const live = livePrompts(prev, userPromptCount(conversation.events));
        return [...live, { id: pendingId, text: trimmed, expect: null }];
      });
    }
    setSendError(null);
    // It didn't go: say why, and drop its bubble, which would otherwise stay on
    // screen for good once a resend of the same text lands in its place. The
    // composer gets the text back (it awaits the `false`).
    const failed = (message: string) => {
      setPending((prev) => prev.filter((p) => p.id !== pendingId));
      setSendError(message);
      return false;
    };
    return whenAttached().then(
      () => deliver(text, attachmentIds, pendingId, failed),
      (error: unknown) => failed(error instanceof Error ? error.message : "Could not connect to send that message."),
    );
  };

  /** Hand a prompt to the session, once it is attached. Anchors its bubble as
   *  the session takes it, against the history that has landed by then. */
  const deliver = (
    text: string,
    attachmentIds: string[],
    pendingId: string,
    failed: (message: string) => boolean,
  ) => {
    if (local) {
      return localAgentRequest(
        localTarget(workspaceId),
        "POST",
        `/workspaces/${workspaceId}/message`,
        { content: text },
      ).then(
        () => {
          anchor(pendingId);
          return true;
        },
        (error: unknown) => failed(error instanceof Error ? error.message : "Could not send that message."),
      );
    }
    return fetch(`/api/workspaces/${workspaceId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, attachmentIds }),
    }).then(
      async (res) => {
        const body = (await res.json().catch(() => ({}))) as { titled?: boolean; error?: string };
        if (!res.ok) return failed(body.error ?? "Could not send that message.");
        anchor(pendingId);
        // The first prompt just named this session: re-read the sidebar.
        if (body.titled) router.refresh();
        return true;
      },
      () => failed("Could not reach Outrunner. Check your connection and send it again."),
    );
  };

  // The model of the most recent assistant turn — shown in the composer so it
  // reflects what's actually running, not a hardcoded label.
  const activeModel = useMemo<string | undefined>(() => {
    for (let i = conversation.events.length - 1; i >= 0; i--) {
      const event = conversation.events[i];
      if (event.t === "message" && event.role === "assistant" && event.model) {
        return event.model;
      }
    }
    return undefined;
  }, [conversation.events]);

  // A session can switch models: the agent relaunches Claude on it with the
  // conversation continued. The pick shows until a reply reports the model it
  // actually ran.
  const [switching, setSwitching] = useState(false);
  // What the model menu offers: Outrunner's models, the user's own keys
  // (Settings → Providers), and their Claude. Until the first answer, as if
  // all were on offer.
  const menu = useOutrunnerModels() ?? MENU_UNTIL_ANSWERED;
  // Whose entry the menu ticks when a model is offered by two: the one last
  // picked here, else the one a new session starts on.
  const [providerPicked, setProviderPicked] = useState<ModelProvider | null>(() => pickedProvider(workspaceId));
  const [picked, setPicked] = useState<{ model: string; events: number } | null>(null);
  // The effort it runs at, as last put on from here (lib/session/picked-effort.ts).
  const [effort, setEffort] = useState<Effort | null>(() => rememberedEffort(workspaceId));
  const repliedSincePick =
    picked !== null &&
    conversation.events
      .slice(picked.events)
      .some((event) => event.t === "message" && event.role === "assistant" && event.model);
  const shownModel = picked && !repliedSincePick ? picked.model : activeModel;
  // A prompt the stream hasn't recorded yet is a turn starting. The agent
  // refuses a switch mid-turn too, since a turn's end can't be read for sure here.
  const delivered = userPromptCount(conversation.events);
  const working =
    claudeIsWorking(conversation.events) || pending.some((p) => pendingShows(p, delivered));
  const modelChoice: ModelChoice = {
    groups: modelGroups(menu, agent),
    effort,
    loadout: menu.loadout,
    preferredProvider: providerPicked ?? defaultModel(menu)?.provider,
    switching,
    disabledReason: !attached
      ? "Waiting for the session to connect"
      : working
        ? `Switch models once ${AGENTS[agent].label} has finished this turn`
        : null,
    onChange: (model, pickedEffort) => {
      // What the agent is told: an effort goes only with a model that takes one.
      const next = takesEffort(model) ? pickedEffort : null;
      setSwitching(true);
      setSendError(null);
      // A local switch relaunches the session on this Mac: signed in as the
      // user picks now first, as the server does for a cloud one.
      (local
        ? deliverLocalAgentAuth(workspaceId, agent).then(() => putOnModel(workspaceId, model, next))
        : switchCloudModel(workspaceId, model, next))
        .then(() => {
          setPicked({ model: model.id, events: conversation.events.length });
          setProviderPicked(model.provider);
          rememberPickedProvider(workspaceId, model.provider);
          setEffort(next);
          rememberEffort(workspaceId, next);
        })
        .catch((error: unknown) =>
          setSendError(
            local ? messageForLocalError(error) : error instanceof Error ? error.message : "Couldn't switch models.",
          ),
        )
        .finally(() => setSwitching(false));
    },
  };

  const timelineEvents = useMemo<AgentEvent[]>(() => {
    const delivered = userPromptCount(conversation.events);
    const optimistic = pending
      .filter((p) => pendingShows(p, delivered))
      .map<AgentEvent>((p) => ({
        t: "message",
        uuid: `optimistic-${p.id}`,
        parentUuid: null,
        role: "user",
        timestamp: new Date().toISOString(),
        content: [{ type: "text", text: p.text }],
      }));
    return optimistic.length ? [...conversation.events, ...optimistic] : conversation.events;
  }, [conversation.events, pending]);

  // An untitled session names itself after the first prompt in its history,
  // once: the server sets a title only where there is none, so this can never
  // rename a session, and a brand-new one titled by its first send just gets
  // `titled: false` back.
  const firstPrompt = untitled ? firstUserPrompt(conversation.events) : null;
  const askedToName = useRef(false);
  useEffect(() => {
    if (!firstPrompt || askedToName.current) return;
    askedToName.current = true;
    fetch(`/api/workspaces/${workspaceId}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: firstPrompt }),
    })
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => ({}))) as { titled?: boolean }) : {};
        if (body.titled) router.refresh();
      })
      .catch(() => {
        /* cosmetic: the session keeps its branch name until the next prompt */
      });
  }, [firstPrompt, workspaceId, router]);

  // Fire the new session's first prompt exactly once, as soon as we hold the
  // keyboard: the one the URL carries, else the one kept for this session
  // while its box was set up (lib/session/first-prompt.ts).
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current || !attached) return;
    const fromUrl: FirstPrompt = { prompt: initialPrompt ?? "", attachmentIds: initialAttachmentIds ?? [] };
    const first = hasFirstPrompt(fromUrl)
      ? fromUrl
      : local
        ? null
        : rememberedFirstPrompt(tabStorage(), workspaceId);
    if (!first) return;
    sentInitial.current = true;
    // send() queues an optimistic bubble (setState); this is a one-time guarded
    // fire on ready, not a render cascade. Another mount of this session may be
    // sending it still: sendFirstPromptOnce waits on that one instead.
    const sessionPath = window.location.pathname;
    void sendFirstPromptOnce(workspaceId, () => send(first.prompt, first.attachmentIds)).then((outcome) => {
      // Forget it only once the POST is accepted, so a failed delivery leaves
      // it in place for a reload to retry. Remove just the first prompt's
      // params (preserving any history state), not the whole query string,
      // and only while this session is still the page: a send that lands
      // after the user moved on must not rewrite another page's URL.
      if (outcome === "failed") return;
      if (!local) forgetFirstPrompt(tabStorage(), workspaceId);
      const url = new URL(window.location.href);
      if (url.pathname === sessionPath) window.history.replaceState(window.history.state, "", withoutFirstPrompt(url));
    });
    // send/terminal are stable enough; guard prevents a repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, initialPrompt, initialAttachmentIds]);

  return (
    <div className="studio-live-session" data-testid="workspace-session">
      {error && (
        <div className="studio-session-error" role="alert">
          <span>{error}</span>
          {connectionError ? (
            <button type="button" onClick={refresh}>Reconnect</button>
          ) : (
            <button type="button" onClick={() => setSendError(null)}>Dismiss</button>
          )}
        </div>
      )}

      <section className="studio-convo-panel" aria-label="Claude conversation">
        <div className="studio-convo-body">
          <ConversationTimeline
            events={timelineEvents}
            placeholder={conversationPlaceholder({
              events: timelineEvents.length,
              attachment: attachment.status,
              stream: conversation.status,
            })}
          />
        </div>
      </section>

      {terminalSlot &&
        createPortal(
          <section
            className={cn("studio-env-terminal", showTerminal && "is-open")}
            aria-label="Live Claude terminal"
          >
            <div className="studio-env-terminal-head">
              <button
                type="button"
                onClick={onToggleTerminal}
                aria-expanded={showTerminal}
                title={showTerminal ? "Hide terminal" : "Show terminal"}
                className="studio-env-terminal-toggle"
              >
                <TerminalSquare /> Terminal
                <ChevronRight className={cn("transition-transform", showTerminal && "rotate-90")} />
              </button>
              {showTerminal && (
                <span className="studio-terminal-role">
                  <Users /> {terminal.role}
                  <button
                    type="button"
                    onClick={refresh}
                    className="studio-term-reconnect"
                    title="Reconnect"
                  >
                    <RefreshCw />
                  </button>
                </span>
              )}
            </div>
            <div ref={setTerminalContainer} className="studio-live-terminal" hidden={!showTerminal} />
            {showTerminal && terminal.exitCode !== null && (
              <p className="studio-terminal-exit">
                Claude exited with code {terminal.exitCode}. Reconnect or start a new
                workspace to begin another session.
              </p>
            )}
          </section>,
          terminalSlot,
        )}

      <SessionComposer
        onSend={send}
        canSend={canSend}
        disabledPlaceholder="Couldn't connect to the session: reconnect to send"
        model={shownModel}
        modelChoice={modelChoice}
        allowAttachments={!local}
      />
    </div>
  );
}

/**
 * A promise for "the session is attached": at once when it is, else when it
 * gets there; rejected, with why, if attaching fails first. What a prompt typed
 * while the session connects waits on.
 */
function useWhenAttached(
  status: "idle" | "loading" | "attached" | "error",
  error: string | null,
): () => Promise<void> {
  const waiting = useRef<{ resolve: () => void; reject: (error: Error) => void }[]>([]);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
    if (status !== "attached" && status !== "error") return;
    const waiters = waiting.current.splice(0);
    for (const waiter of waiters) {
      if (status === "attached") waiter.resolve();
      else waiter.reject(new Error(error ?? "Could not connect to the session."));
    }
  }, [status, error]);
  return useCallback(
    () =>
      statusRef.current === "attached"
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => waiting.current.push({ resolve, reject })),
    [],
  );
}

/** Switch a cloud session's model. The server adds the key the model needs
 *  and calls the session's agent, so the key stays off the browser. */
async function switchCloudModel(workspaceId: string, model: SessionModel, effort: Effort | null): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: model.provider, model: model.id, ...(effort && { effort }) }),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "Couldn't switch models. Please try again.");
}

/** Who served a session's model when it was last picked here (a convenience:
 *  the reply names only the model, the same from either provider). */
function pickedProvider(workspaceId: string): ModelProvider | null {
  try {
    const saved = window.localStorage.getItem(`outrunner:model-key:${workspaceId}`);
    // Saved before providers: "own" was the user's OpenRouter key, and
    // "neev" Outrunner's, before the rename.
    if (saved === "own") return "openrouter";
    if (saved === "neev") return "outrunner";
    return saved === "outrunner" || saved === "claude" || saved === "codex" || isProviderId(saved) ? saved : null;
  } catch {
    return null;
  }
}

function rememberPickedProvider(workspaceId: string, provider: ModelProvider): void {
  try {
    window.localStorage.setItem(`outrunner:model-key:${workspaceId}`, provider);
  } catch {
    // Blocked storage only costs the tick going back to the default.
  }
}
