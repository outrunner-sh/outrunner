"use client";

import "@xterm/xterm/css/xterm.css";

import { ChevronRight, RefreshCw, RotateCw, TerminalSquare, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { ConversationTimeline, claudeIsWorking } from "@/components/conversation-timeline";
import { SessionComposer, type ModelChoice } from "@/components/session-composer";
import { ErrorRef, Notice, TickingFact } from "@/components/ui/notice";
import { deliverLocalAgentAuth, LocalAgentAuthError } from "@/lib/desktop/local-agent-auth";
import {
  LOCAL_RUNNER_LOG,
  localAgentRequest,
  localTarget,
  LocalRuntimeError,
  messageForLocalError,
  putOnModel,
  runnerDidNotStartDetail,
} from "@/lib/desktop/local-runtime";
import { firstUserPrompt, userPromptCount } from "@/lib/runtime/conversation-events";
import { conversationPlaceholder } from "@/lib/session/conversation-placeholder";
import { SEND_FAILED, sendFailureMessage } from "@/lib/session/send-failure";
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
import { defaultModel, modelGroups, type ModelProvider, type SessionModel } from "@/lib/runtime/session-models";
import { outrunnerModels, type OutrunnerModels } from "@/lib/desktop/local-runtime";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useSessionTerminal } from "@/hooks/use-session-terminal";
import { cn } from "@/lib/utils";

/** The app's own errors are already sentences (messageForLocalError); what the
 *  agent itself said goes through the same filter as a hosted send's. */
function localSendFailure(error: unknown): string {
  console.error("Send failed", error);
  if (!(error instanceof LocalRuntimeError)) return SEND_FAILED;
  if (error.code === "agent" && error.reason !== "unknown workspace") return sendFailureMessage(error.reason);
  return error.message;
}

/** A send that didn't go: why, and how to try it again. `retry` is set only
 * where its text never was in the composer's box (a session's first prompt),
 * so the box's Retry sends the original rather than an empty box. */
type FailedSend = { message: string; retry?: () => void };

export function WorkspaceSession({
  workspaceId,
  projectId,
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
  /** Its repository, so a session whose box is gone can continue in a new one there. */
  projectId?: string;
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
  const [sendError, setSendError] = useState<FailedSend | null>(null);
  // A model switch that didn't happen: which model, why, and where to fix it.
  const [switchError, setSwitchError] = useState<{ label: string; message: string; href?: string } | null>(null);
  // A failed send is shown by the composer, with a way to send it again: the box's own text comes back to it; a session's first prompt, which never was in the box, retries its original.
  // A dropped stream gets its own notice (retrying, then lost) instead of the
  // strip, so a handshake failure mid-retry doesn't flash red.
  const streamDropped = conversation.reconnecting !== null || conversation.lost;
  // The box's own answer wins over the stream's: a box that is gone explains a
  // socket that can't reconnect, so its notice — and its way out — is the one
  // to show, whatever the stream said before it closed. (The stream reports
  // the attachment's error as its own only until it has one of its own.)
  const fromBox = attachment.error !== null;
  const connectionError = streamDropped ? null : (fromBox ? attachment.error : conversation.error);
  const refresh = () => {
    setSendError(null);
    conversation.refresh();
  };
  const canSend = attachment.status === "attached";

  // Optimistic echo: the prompt only reaches the timeline after Claude logs it
  // and the agent streams it back (a second or two). Show the user's own bubble
  // immediately and drop it once the streamed copy of that turn arrives, so the
  // composer feels instant without ever double-rendering the message.
  // Each pending item remembers the delivered-prompt count it is waiting to
  // exceed. Sends are serialized, so the Nth optimistic bubble is superseded
  // once the stream has recorded N prompts — independent of the text, so
  // duplicate messages and Claude's text-less tool-result user turns can't
  // confuse the match.
  const [pending, setPending] = useState<{ id: string; text: string; expect: number }[]>([]);

  const send = (text: string, attachmentIds: string[] = [], retry?: () => void) => {
    const trimmed = text.trim();
    const pendingId = crypto.randomUUID();
    if (trimmed) {
      setPending((prev) => {
        const base = userPromptCount(conversation.events);
        // Drop items the stream has already caught up on, then queue this one to
        // wait for the next prompt slot. Trimming here (not in an effect) keeps
        // the list bounded without a setState-in-effect cascade.
        const live = prev.filter((p) => base < p.expect);
        const expect = Math.max(base + 1, live.length ? live[live.length - 1].expect + 1 : 0);
        return [...live, { id: pendingId, text: trimmed, expect }];
      });
    }
    setSendError(null);
    // It didn't go: say why, and drop its bubble, which would otherwise stay on
    // screen for good once a resend of the same text lands in its place. The
    // composer gets the text back (it awaits the `false`).
    const failed = (message: string) => {
      setPending((prev) => prev.filter((p) => p.id !== pendingId));
      setSendError({ message, retry });
      return false;
    };
    if (local) {
      return localAgentRequest(
        localTarget(workspaceId),
        "POST",
        `/workspaces/${workspaceId}/message`,
        { content: text },
      ).then(
        () => true,
        (error: unknown) => failed(localSendFailure(error)),
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
        // The first prompt just named this session: re-read the sidebar.
        if (body.titled) router.refresh();
        return true;
      },
      () => failed("Couldn't reach Outrunner. Check your connection."),
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
  // (Settings → Providers), and their Claude.
  const [menu, setMenu] = useState<OutrunnerModels>({
    outrunner: true,
    allowance: false,
    keys: [],
    available: true,
    loadout: EMPTY_LOADOUT,
  });
  useEffect(() => {
    let live = true;
    void outrunnerModels().then((answer) => {
      if (live) setMenu(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  // Whose entry the menu ticks when a model is offered by two: the one last
  // picked here, else the one a new session starts on.
  const [providerPicked, setProviderPicked] = useState<ModelProvider | null>(() => pickedProvider(workspaceId));
  const [picked, setPicked] = useState<{ model: string; events: number } | null>(null);
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
    claudeIsWorking(conversation.events) || pending.some((p) => delivered < p.expect);
  const modelChoice: ModelChoice = {
    groups: modelGroups(menu, agent),
    loadout: menu.loadout,
    preferredProvider: providerPicked ?? defaultModel(menu)?.provider,
    switching,
    disabledReason: !canSend
      ? "Waiting for the session to connect"
      : working
        ? `Switch models once ${AGENTS[agent].label} has finished this turn`
        : null,
    onChange: (model) => {
      setSwitching(true);
      setSendError(null);
      setSwitchError(null);
      // A local switch relaunches the session on this Mac: signed in as the
      // user picks now first, as the server does for a cloud one.
      (local
        ? deliverLocalAgentAuth(workspaceId, agent).then(() => putOnModel(workspaceId, model))
        : switchCloudModel(workspaceId, model))
        .then(() => {
          setPicked({ model: model.id, events: conversation.events.length });
          setProviderPicked(model.provider);
          rememberPickedProvider(workspaceId, model.provider);
        })
        .catch((error: unknown) =>
          setSwitchError({
            label: model.label,
            message: local ? messageForLocalError(error) : error instanceof Error ? error.message : "Couldn't switch models.",
            href:
              error instanceof ModelSwitchError || error instanceof LocalAgentAuthError ? error.settingsHref : undefined,
          }),
        )
        .finally(() => setSwitching(false));
    },
  };

  const timelineEvents = useMemo<AgentEvent[]>(() => {
    const delivered = userPromptCount(conversation.events);
    const optimistic = pending
      .filter((p) => delivered < p.expect)
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
    if (sentInitial.current || !canSend) return;
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
    // The prompt went: forget the kept copy, and the URL's params (only while
    // this session is still the page, preserving any history state), so a
    // reload can't send it again. Nothing is forgotten until the POST is
    // accepted, so a failed delivery leaves it in place for a retry or a reload.
    const itWent = () => {
      if (!local) forgetFirstPrompt(tabStorage(), workspaceId);
      const url = new URL(window.location.href);
      if (url.pathname === sessionPath) window.history.replaceState(window.history.state, "", withoutFirstPrompt(url));
    };
    // Send it, cleaning up only once it lands. A failed send keeps its Retry.
    const attempt = (): Promise<boolean> =>
      send(first.prompt, first.attachmentIds, retry).then((landed) => {
        if (landed) itWent();
        return landed;
      });
    // The composer's Retry re-enters through the same once-per-tab gate as
    // the first try, so a retry racing a remounted page still sends it once.
    const retry = (): void => void sendFirstPromptOnce(workspaceId, attempt);
    void sendFirstPromptOnce(workspaceId, attempt).then((outcome) => {
      // Another page of this tab sent it first: its send cleaned up after
      // itself, but this URL may still be the one carrying the prompt.
      if (outcome === "already") itWent();
    });
    // send/terminal are stable enough; guard prevents a repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSend, initialPrompt, initialAttachmentIds]);

  return (
    <div className="studio-live-session" data-testid="workspace-session">
      {conversation.lost ? (
        <Notice
          tone="warning"
          title="Lost connection to this session"
          detail="It's still running on its box, so nothing is lost."
          actions={[
            {
              label: "Reconnect",
              icon: <RotateCw className={conversation.retrying ? "is-working" : undefined} />,
              primary: true,
              disabled: conversation.retrying,
              onClick: refresh,
            },
          ]}
        />
      ) : (
        conversation.reconnecting && <ReconnectingNotice {...conversation.reconnecting} />
      )}
      {switchError && !connectionError && !streamDropped && (
        <Notice
          tone="error"
          title={`Couldn't switch to ${switchError.label}`}
          detail={`${switchError.message} The session stays on its current model.`}
          actions={[
            ...(switchError.href ? [{ label: "Open settings", href: switchError.href }] : []),
            { label: "Dismiss", onClick: () => setSwitchError(null) },
          ]}
        />
      )}
      {conversation.protocolErrorRef && !connectionError && !streamDropped && (
        <Notice
          tone="warning"
          title="Something went wrong in this session"
          detail="Part of the conversation couldn't be shown. Reloading usually fixes it."
          meta={<ErrorRef value={conversation.protocolErrorRef} />}
          actions={[{ label: "Reload", icon: <RotateCw />, primary: true, onClick: () => window.location.reload() }]}
        />
      )}
      {connectionError && (
        <ConnectionNotice
          // The server's sentence about the box; a stream error is internal.
          message={fromBox ? attachment.error : null}
          code={fromBox ? attachment.errorCode : null}
          reason={fromBox ? attachment.errorReason : null}
          retrying={attachment.status === "loading"}
          projectId={projectId}
          onRetry={refresh}
        />
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
              <Notice
                tone="warning"
                className="studio-terminal-exit"
                title={`${AGENTS[agent].label} stopped`}
                detail="This session and its files are kept."
                meta={`exit code ${terminal.exitCode}`}
                actions={[{ label: "Reconnect", icon: <RotateCw />, primary: true, onClick: refresh }]}
              />
            )}
          </section>,
          terminalSlot,
        )}

      <SessionComposer
        onSend={send}
        canSend={canSend}
        // Sending waits on the connection alone, so say that, not the
        // composer's default (another viewer holding the keyboard).
        disabledPlaceholder={
          attachment.status === "error" ? "You can send once this session is back." : "Connecting to this session…"
        }
        model={shownModel}
        modelChoice={modelChoice}
        allowAttachments={!local}
        sendError={connectionError ? null : (sendError?.message ?? null)}
        onDismissSendError={() => setSendError(null)}
        onRetrySendError={sendError?.retry}
      />
    </div>
  );
}

/** Why the live session can't be shown, by what the server said of its box. */
function ConnectionNotice({
  message,
  code,
  reason,
  retrying,
  projectId,
  onRetry,
}: {
  message: string | null;
  code: string | null;
  reason: string | null;
  /** A retry is under way: its button turns rather than the notice going. */
  retrying: boolean;
  projectId?: string;
  onRetry: () => void;
}) {
  const retry = (label: string) => ({
    label,
    icon: <RotateCw className={retrying ? "is-working" : undefined} />,
    primary: true,
    disabled: retrying,
    onClick: onRetry,
  });
  if (code === "agent-did-not-start" || code === "agent-spawn-failed") {
    // Trying again starts the runner afresh: the app restarts one that died.
    return (
      <Notice
        tone="error"
        title="This Mac's session runner didn't start"
        detail={runnerDidNotStartDetail(reason)}
        meta={<ErrorRef label="log" value={LOCAL_RUNNER_LOG} />}
        actions={[retry("Try again")]}
      />
    );
  }
  if (code === "box-gone") {
    return (
      <Notice
        tone="warning"
        title="This session's box ended"
        detail="It couldn't be restored, so its uncommitted files are gone. Anything pushed to GitHub is kept."
        actions={[
          { label: "Continue in a new session", primary: true, href: projectId ? `/new?project=${projectId}` : "/new" },
        ]}
      />
    );
  }
  if (code === "box-restore-failed") {
    return (
      <Notice
        tone="warning"
        title="Couldn't restart this session's box"
        detail="Its files are kept on the box's disk. This is usually brief."
        actions={[retry("Try again")]}
      />
    );
  }
  return (
    <Notice
      tone="warning"
      title="Can't show this session live"
      detail={message ? `It may still be running. ${message}` : "It may still be running on its box."}
      actions={[retry("Retry")]}
    />
  );
}

function ReconnectingNotice({ attempt, max, since }: { attempt: number; max: number; since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <Notice
      tone="progress"
      title="Reconnecting to this session…"
      meta={
        <>
          {attempt > 0 && <span>attempt {Math.min(attempt, max)} of {max}</span>}
          {/* The elapsed clock ticks every second, so it stays out of the
              live region; the attempt line is announced only when it changes. */}
          <TickingFact>
            {attempt > 0 ? " · " : ""}
            {elapsed}
          </TickingFact>
        </>
      }
    />
  );
}

/** Switch a cloud session's model. The server adds the key the model needs
 *  and calls the session's agent, so the key stays off the browser. */
async function switchCloudModel(workspaceId: string, model: SessionModel): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: model.provider, model: model.id }),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string; settingsHref?: string };
  throw new ModelSwitchError(data.error ?? "Couldn't switch models. Please try again.", data.settingsHref);
}

/** A refused switch, with the settings page that fixes it when one does. */
class ModelSwitchError extends Error {
  readonly settingsHref?: string;
  constructor(message: string, settingsHref?: string) {
    super(message);
    this.name = "ModelSwitchError";
    this.settingsHref = settingsHref;
  }
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
