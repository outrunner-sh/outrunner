"use client";

import { RotateCw } from "lucide-react";
import { DRAFTS } from "@/lib/client/drafts";
import { useViewerScope } from "@/components/app-data";
import { RECENT_SELECTION } from "@/lib/session/kept-selection";
import { sessionModelToRemember } from "@/lib/session/recent-selection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type AgentEvent, ChangesResponse, FilesResponse, PlanActionResponse, RewindResponse } from "@/lib/runtime/agent-protocol";
import { ConversationTimeline } from "@/components/conversation-timeline";
import { ImageBoxContext } from "@/components/markdown";
import { QueuedPrompts } from "@/components/queued-prompts";
import { QueuedFirstPrompt, StartupStatus, type SessionStartup } from "@/components/workspace-creating";
import { useQueuedFirstPrompt } from "@/hooks/use-queued-first-prompt";
import { QuestionCard } from "@/components/question-card";
import { pendingSecretRequest, type PendingSecretRequest } from "@/lib/runtime/pending-secrets";
import { SecretsCard } from "@/components/secrets-card";
import { SessionComposer, type ModelChoice } from "@/components/session-composer";
import { ErrorRef, InlineMessage, Notice, TickingFact } from "@/components/ui/notice";
import { deliverLocalAgentAuth, LocalAgentAuthError } from "@/lib/desktop/local-agent-auth";
import {
  LOCAL_RUNNER_LOG,
  LocalRuntimeError,
  accountsHere,
  localAgentRequest,
  localTarget,
  localSendFailure,
  messageForLocalError,
  putOnModel,
  runnerDidNotStartDetail,
} from "@/lib/desktop/local-runtime";
import { claudeIsWorking, firstUserPrompt, replyModel, userPromptCount, userPrompts } from "@/lib/runtime/conversation-events";
import { contextReportOffered, contextUsage } from "@/lib/runtime/context-usage";
import { pendingPlan } from "@/lib/runtime/pending-plan";
import { rememberedMode, rememberMode, type SessionMode } from "@/lib/session/session-mode";
import {
  type AskAnswer,
  isExpiredQuestionError,
  pendingQuestion,
  type PendingQuestion,
} from "@/lib/runtime/pending-question";
import {
  echoUuid,
  livePrompts,
  pendingAfterStop,
  pendingShows,
  settlePending,
  type PendingPrompt,
} from "@/lib/session/optimistic-echo";
import { conversationPlaceholder } from "@/lib/session/conversation-placeholder";
import { changedOnly } from "@/lib/session/file-mentions";
import { reachOutrunner } from "@/lib/http/request-json";
import {
  dropFirstPromptFromAddressBar,
  firstPromptCutOff,
  forgetFirstPrompt,
  hasFirstPrompt,
  markFirstPromptGoing,
  rememberedFirstPrompt,
  sendFirstPromptOnce,
  tabStorage,
  type FirstPrompt,
} from "@/lib/session/first-prompt";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { eligibleHarnesses, selectionForHarness } from "@/lib/runtime/selection";
import { exhaustion, hasUnfinishedRequest, HarnessSelection, PendingHarness } from "@/lib/session/harness-switch";
import { EMPTY_LOADOUT } from "@/lib/runtime/model-loadout";
import {
  defaultModel,
  type Effort,
  modelGroups,
  compatibleEffort,
  matchModel,
  type ModelProvider,
  parseAgentConnections,
  type RecordedModel,
  runsOnOwnAccount,
  type SessionModel,
} from "@/lib/runtime/session-models";
import { sessionTitle } from "@/lib/nav/session-title";
import { rememberedEffort, rememberEffort } from "@/lib/session/picked-effort";
import { pickedProvider, rememberPickedProvider } from "@/lib/session/picked-provider";
import { chatRoute, chatStateKey, MAIN_CHAT } from "@/lib/session/chats";
import { followUpRoute } from "@/lib/session/chat-preferences";
import { editQueued, moveQueued, type QueuedPrompt, queueDrains, readQueue, writeQueue } from "@/lib/session/prompt-queue";
import { runQueuedAction } from "@/lib/session/queue-actions";
import { patchRowAhead } from "@/lib/session/rows-ahead";
import { sendIsDeadEnd } from "@/lib/session/send-failure";
import { BOX_GONE, BOX_RESTORE_FAILED, SESSION_ENDED, SESSION_NOT_STARTED } from "@/lib/session/session-codes";
import type { OutrunnerModels } from "@/lib/desktop/local-runtime";
import { useOutrunnerModels } from "@/hooks/use-outrunner-models";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useDiffComments } from "@/hooks/use-diff-comments";
import { withComments } from "@/lib/session/diff-comments";
import { useSessionAttachment } from "@/hooks/use-session-attachment";
import { useChatPreferences } from "@/hooks/use-chat-preferences";
import { attachmentFilenames, promptWithAttachments } from "@/lib/runtime/attachments";
import { previewOf } from "@/lib/session/attachment-previews";

/** A send that didn't go: why, and how to try it again. `retry` is set only
 * where its text never was in the composer's box (a session's first prompt),
 * so the box's Retry sends the original rather than an empty box. `code` is
 * the route's, when it gave one, so a dead end offers no retry. */
type FailedSend = { message: string; retry?: () => void; code?: string };

/** How long the queue waits, the session idle, for the stream to record the
 *  last queued prompt sent before sending the next anyway. */
const QUEUED_ECHO_WAIT_MS = 30_000;

/** How long a compaction under way holds the session as busy, at most, if
 *  the stream never shows it done (an agent whose log doesn't record it). */
const COMPACT_WAIT_MS = 5 * 60_000;

/** How a prompt goes: in a mode, and answering the plan the agent waits on. */
type SendHow = { mode?: SessionMode; dismiss?: boolean; queuedKey?: string; sentAt?: number };

const MENU_UNTIL_ANSWERED: OutrunnerModels = {
  outrunner: false,
  allowance: false,
  keys: [],
  available: false,
  codexModels: [],
  loadout: EMPTY_LOADOUT,
  agents: parseAgentConnections(undefined),
};

/** Sends a prompt into the session as the composer does, resolving whether it
 *  went: handed out (WorkspaceSession's `onSender`) while the session can send. */
export type SessionSender = {
  send: (text: string, attachmentIds?: string[]) => Promise<boolean>;
};

export function WorkspaceSession({
  workspaceId,
  startup,
  chatId = MAIN_CHAT,
  projectId,
  agent: initialAgent = "claude",
  recorded: initialRecorded = null,
  initialMode = "build",
  local = false,
  untitled = false,
  initialPrompt,
  initialPromptKey,
  initialAttachmentIds,
  storedFirstPrompt = null,
  onSender,
  onSideChat,
  allowHarnessSwitch = false,
}: {
  workspaceId: string;
  startup?: SessionStartup;
  /** The chat it shows (lib/session/chats.ts): its main one unless another
   *  is picked. Each keeps its own conversation, queue and model here. */
  chatId?: string;
  /** Its repository, so a session whose box is gone can continue in a new one there. */
  projectId?: string;
  /** The coding agent the session runs: its model menu offers only models
   *  that agent runs. */
  agent?: AgentId;
  /** The model and effort its row records it was last put on (a cloud
   *  session's), shown until a reply or a pick here says otherwise. */
  recorded?: RecordedModel | null;
  /** The mode its row records its prompts last went in (a cloud session's);
   *  a local session's is kept in this browser. */
  initialMode?: SessionMode;
  /** A local session: everything then goes through the Outrunner app to the
   *  agent on this Mac, instead of through the server. */
  local?: boolean;
  /** A cloud session with no title yet, which takes one from the first prompt
   *  in its history (sessions from before titles were saved). */
  untitled?: boolean;
  /** First prompt to send once the session accepts input (from /new). */
  initialPrompt?: string;
  /** Its idempotency key: every send of it names it, so the server sends it
   *  once (lib/session/first-prompt-claim.ts). */
  initialPromptKey?: string;
  /** Attachment ids from the home composer, delivered with the first prompt. */
  initialAttachmentIds?: string[];
  /** The first prompt kept on the session's row while its box started
   *  (workspaces.first_prompt): this tab's last copy of it — a tab that
   *  closed and reopened sends it when it never kept or carried one, and it
   *  goes even with no tab at all (setup delivers it). Same prompt, same key,
   *  so whichever copy sends, the box gets it once. */
  storedFirstPrompt?: FirstPrompt | null;
  /** Given a sender while the session can send, null when it no longer can:
   *  for prompts from outside the composer (Create PR). Must be stable. */
  onSender?: (sender: SessionSender | null) => void;
  /** `/btw <question>`: ask it in a side chat about this one (the studio
   *  starts it and shows it); resolves whether it went. */
  onSideChat?: (question: string) => Promise<boolean>;
  allowHarnessSwitch?: boolean;
}) {
  // What this page keeps of the chat (its conversation, queue, picks): the
  // session's own keys for its main chat, as before there were others.
  const stateKey = chatStateKey(workspaceId, chatId);
  const [activeSelection, setActiveSelection] = useState<{ agent: AgentId; recorded: RecordedModel; operationId: string } | null>(null);
  const [pendingHarness, setPendingHarness] = useState<PendingHarness | null>(null);
  const harnessSending = useRef(false);
  const harnessStorageKey = `harness-switch:${stateKey}`;
  const keepHarness = (next: PendingHarness | null) => {
    try {
      if (next) tabStorage()?.setItem(harnessStorageKey, JSON.stringify(next));
      else tabStorage()?.removeItem(harnessStorageKey);
    } catch { return false; }
    setPendingHarness(next);
    return true;
  };
  useEffect(() => {
    let saved: PendingHarness | null = null;
    try {
      const parsed = PendingHarness.safeParse(JSON.parse(tabStorage()?.getItem(harnessStorageKey) ?? "null"));
      if (parsed.success) saved = parsed.data;
    } catch { /* no saved transition */ }
    queueMicrotask(() => setPendingHarness(saved));
  }, [harnessStorageKey]);
  // Whether a follow-up sent mid-turn steers it or queues (Settings → Account).
  const chatPreferences = useChatPreferences();
  const attachment = useSessionAttachment(workspaceId, local, activeSelection?.agent ?? initialAgent, chatId, !startup);
  const conversation = useConversationStream(attachment, stateKey);
  const boundary = [...conversation.events].reverse().find((event) => event.t === "message" && event.harness);
  const carriedSelection = HarnessSelection.safeParse(boundary?.t === "message" ? boundary.harness?.selection : undefined);
  const localBoundaryIndex = activeSelection ? conversation.events.findIndex((event) => event.t === "message" && event.uuid === `harness-${activeSelection.operationId}`) : -1;
  const useLocalSelection = activeSelection !== null && (localBoundaryIndex < 0 || !boundary || conversation.events.indexOf(boundary) <= localBoundaryIndex);
  const agent = useLocalSelection ? activeSelection.agent : boundary?.t === "message" && boundary.harness ? boundary.harness.to : initialAgent;
  const savedSelection = initialAgent === agent ? initialRecorded : null;
  // A boundary records the choice at handoff, before any later model/effort
  // changes. On reload the saved row is current for its harness; a boundary
  // only supplies a selection when the page still belongs to the old harness.
  const recorded = useLocalSelection ? activeSelection.recorded
    : savedSelection ? savedSelection
    : carriedSelection.success ? carriedSelection.data as RecordedModel : initialRecorded;
  const firstQueued = useQueuedFirstPrompt(
    workspaceId,
    { prompt: initialPrompt ?? "", attachmentIds: initialAttachmentIds ?? [], ...(initialPromptKey && { key: initialPromptKey }) },
    storedFirstPrompt,
  );
  const [initialDeliveryComplete, setInitialDeliveryComplete] = useState(false);

  // The jcode engine has no PTY: prompts go over the /message API and the reply
  // streams back on the Conversation SSE. So input readiness and errors come
  // from the session attachment + conversation stream.
  const [sendError, setSendError] = useState<FailedSend | null>(null);
  // An answer that didn't go: why, under the card that asked it. The next
  // answer retires it, and the card leaving takes it along.
  const [answerError, setAnswerError] = useState<string | null>(null);
  // A question that was over before its answer got there: nothing failed to
  // send, so it is said as news above the composer, not as a send failure.
  const [questionGone, setQuestionGone] = useState<string | null>(null);
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
    setAnswerError(null);
    conversation.refresh();
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

  /** The prompt has reached the session, handed over at `sentAt` recorded
   *  prompts: drop its bubble if the stream already has it, else hold it until
   *  the stream records one more prompt than the history it answered with. */
  const anchor = (pendingId: string, sentAt: number) =>
    setPending((prev) => settlePending(prev, pendingId, userPrompts(eventsRef.current), sentAt));

  /** `leaving` is called as the request itself goes, once attached. A
   *  session's first prompt names its `firstPromptKey`, so the server sends it
   *  once however often it is asked. */
  const send = (
    text: string,
    attachmentIds: string[] = [],
    retry?: () => void,
    leaving?: () => void,
    firstPromptKey?: string,
    how: SendHow = {},
  ) => {
    const trimmed = text.trim();
    const pendingId = crypto.randomUUID();
    // Files alone are a message too: their bubble shows them.
    if (trimmed || attachmentIds.length > 0) {
      setPending((prev) => {
        // Drop items the stream has already caught up on, then queue this one.
        // Trimming here (not in an effect) keeps the list bounded without a
        // setState-in-effect cascade.
        const live = livePrompts(prev, userPromptCount(conversation.events));
        return [
          ...live,
          { id: pendingId, text: trimmed, expect: null, ...(attachmentIds.length > 0 && { attachmentIds }) },
        ];
      });
    }
    setSendError(null);
    setQuestionGone(null);
    // It didn't go: say why, and drop its bubble, which would otherwise stay on
    // screen for good once a resend of the same text lands in its place. The
    // composer gets the text back (it awaits the `false`).
    const failed = (message: string, code?: string) => {
      setPending((prev) => prev.filter((p) => p.id !== pendingId));
      setSendError({ message, retry, code });
      return false;
    };
    return whenAttached().then(
      () => {
        leaving?.();
        return deliver(text, attachmentIds, pendingId, failed, firstPromptKey, how);
      },
      (error: unknown) => failed(error instanceof Error ? error.message : "Could not connect to send that message."),
    );
  };

  /** Hand a prompt to the session, once it is attached. Anchors its bubble as
   *  the session takes it, against the history that has landed by then. */
  const deliver = (
    text: string,
    attachmentIds: string[],
    pendingId: string,
    failed: (message: string, code?: string) => boolean,
    firstPromptKey?: string,
    how: SendHow = {},
  ) => {
    // The stream may record the prompt before the session answers.
    const sentAt = how.sentAt ?? userPromptCount(eventsRef.current);
    if (local) {
      return localAgentRequest(
        localTarget(workspaceId),
        "POST",
        `/workspaces/${workspaceId}/message`,
        { content: text, ...how },
      ).then(
        () => {
          anchor(pendingId, sentAt);
          return true;
        },
        (error: unknown) => failed(localSendFailure(error)),
      );
    }
    return fetch(chatRoute(workspaceId, chatId, "message"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, attachmentIds, ...(firstPromptKey && { firstPromptKey }), ...(how.mode && { mode: how.mode }), ...(how.dismiss && { dismiss: true }), ...(how.queuedKey && { queuedKey: how.queuedKey }) }),
    }).then(
      async (res) => {
        const body = (await res.json().catch(() => ({}))) as { titled?: boolean; error?: string; code?: string; result?: string };
        if (!res.ok) return failed(body.error ?? "Could not send that message.", body.code);
        if (body.result === "already") setPending((prev) => prev.filter((p) => p.id !== pendingId));
        else anchor(pendingId, sentAt);
        // The first prompt just named this session, as the server names it:
        // the sidebar shows the name at once (lib/session/rows-ahead.ts).
        const title = body.titled ? sessionTitle(text) : null;
        if (title) patchRowAhead(workspaceId, { title });
        return true;
      },
      () => failed("Couldn't reach Outrunner. Check your connection."),
    );
  };

  // Create PR, in the Environment panel, sends through here too: its prompt
  // gets the composer's bubble and error. The sender reads `send` as of the
  // last render, so handing it out once per connection is enough.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!canSend || startup || !initialDeliveryComplete || !onSender) return;
    onSender({ send: (text, attachmentIds) => sendRef.current(text, attachmentIds) });
    return () => onSender(null);
  }, [canSend, startup, initialDeliveryComplete, onSender]);

  // The model of the most recent assistant turn — shown in the composer so it
  // reflects what's actually running, not a hardcoded label. Claude Code's
  // own stand-ins (an API error's `<synthetic>`) name no model, and are passed.
  const activeModel = useMemo<string | undefined>(() => {
    for (let i = conversation.events.length - 1; i >= 0; i--) {
      const event = conversation.events[i];
      if (event.t === "message" && event.harness) return undefined;
      const model = replyModel(conversation.events[i]);
      if (model) return model;
    }
    return undefined;
  }, [conversation.events]);

  // A session can switch models: the agent relaunches Claude on it with the
  // conversation continued. The pick shows until a reply reports the model it
  // actually ran.
  const [switching, setSwitching] = useState(false);
  // What the model menu offers: Outrunner's models, the user's own keys
  // (Settings → Providers), and connected accounts. Before the verified
  // menu arrives, keep the recorded selection without offering guessed models.
  const menu = useOutrunnerModels(local ? undefined : workspaceId) ?? MENU_UNTIL_ANSWERED;
  // Whose entry the menu ticks when a model is offered by two: the one last
  // picked here, else the one a new session starts on.
  const [providerPicked, setProviderPicked] = useState<ModelProvider | null>(() => local && !recorded ? pickedProvider(stateKey) : null);
  const [picked, setPicked] = useState<{ model: string; events: number } | null>(null);
  // The effort it runs at, as last put on from here (lib/session/picked-effort.ts);
  // none put on from here (a session started from onboarding, or another
  // browser), as its row records. Undefined until either says.
  const [effortHere, setEffortHere] = useState<Effort | null | undefined>(
    () => local && !recorded ? rememberedEffort(stateKey) ?? undefined : undefined,
  );
  const effort = effortHere !== undefined ? effortHere : (recorded?.effort ?? null);
  const repliedSincePick =
    picked !== null &&
    conversation.events
      .slice(picked.events)
      .some((event) => event.t === "message" && event.role === "assistant" && event.model);
  // After a handoff/reload, the saved choice can be newer than the last
  // reply too. Picks in this page continue to take over as they did before.
  const savedModel = boundary && !useLocalSelection && !picked ? savedSelection?.model.id : undefined;
  const shownModel = picked && !repliedSincePick ? picked.model : (savedModel ?? activeModel ?? recorded?.model.id);
  // Carry this chat's actual selection to the next new session. A staged or
  // failed switch never changes it; successful switches update shownModel.
  const viewerScope = useViewerScope();
  const currentModel = sessionModelToRemember(modelGroups(menu, accountsHere(menu.agents, local, null), agent), shownModel, providerPicked ?? undefined, recorded?.model);
  const currentProvider = currentModel?.provider;
  const currentModelId = currentModel?.id;
  const selectionReady = !startup;
  useEffect(() => {
    if (selectionReady && viewerScope && currentProvider && currentModelId) {
      RECENT_SELECTION.remember({ provider: currentProvider, id: currentModelId, agent, effort }, viewerScope);
    }
  }, [selectionReady, viewerScope, currentProvider, currentModelId, agent, effort]);
  // Stopping the turn under way (the composer's stop button): the agent
  // presses Escape in the session and answers once the turn has stopped.
  const [stopping, setStopping] = useState(false);
  // A stop that didn't happen: why, as its own notice. Not the composer's
  // send line, which offers to send again — the turn, not a send, failed.
  const [stopError, setStopError] = useState<string | null>(null);
  // The prompts recorded when a turn was last stopped: the turn is over until
  // the next, even where the agent records nothing of the stop (Codex).
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  // The questions the agent is waiting on the user to answer: the composer
  // gives way to their card. One answered or dismissed here is put away at
  // once, kept hidden while its answer is on the way (and offered again if
  // that fails), until its result reaches the stream.
  const question = useMemo(() => pendingQuestion(conversation.events), [conversation.events]);
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  // The secrets the agent asked for (request_secrets), the same way: a form
  // in place of the composer, put away while its answer is on the way.
  const secretRequest = useMemo(() => pendingSecretRequest(conversation.events), [conversation.events]);
  // Walks the conversation back for where Claude last compacted: once per
  // change, not on every render.
  const contextNow = useMemo(() => contextUsage(conversation.events, shownModel), [conversation.events, shownModel]);
  const waitingOnSecrets = secretRequest !== null && !answeredHere.has(secretRequest.toolUseId);
  const [secretsSaveError, setSecretsSaveError] = useState<string | null>(null);
  const waitingOnUser = (question !== null && !answeredHere.has(question.toolUseId)) || waitingOnSecrets;
  // The mode the composer's prompts go in: as the session was left (its row,
  // or this browser for a local session), switched with the toggle.
  const [mode, setModeState] = useState<SessionMode>(() => (local ? rememberedMode(workspaceId) : null) ?? initialMode);
  const setMode = (next: SessionMode) => {
    setModeState(next);
    rememberMode(workspaceId, next);
  };
  // The plan the agent waits on approval for (pending-plan.ts): a card in the
  // conversation, Approve and Revise on it. The composer stays: what is typed
  // while it waits revises it. An answer on its way puts the card's buttons
  // away, as a question's card is, until its result reaches the stream.
  const plan = pendingPlan(conversation.events, { plansInProse: agent === "codex", working: claudeIsWorking(conversation.events) });
  const waitingOnPlan = plan !== null && !answeredHere.has(plan.id);
  // A compaction asked for, the stream's length then, until the stream shows
  // one after it: the session is busy meanwhile, and the queue waits.
  const [compactingFrom, setCompactingFrom] = useState<number | null>(null);
  // What happened other than what was asked (a compaction without its
  // instructions, a plan answered elsewhere), said once.
  const [note, setNote] = useState<string | null>(null);
  const compacting =
    compactingFrom !== null && !conversation.events.slice(compactingFrom).some((e) => e.t === "message" && e.compact);
  useEffect(() => {
    if (!compacting) return;
    const giveUp = setTimeout(() => setCompactingFrom(null), COMPACT_WAIT_MS);
    return () => clearTimeout(giveUp);
  }, [compacting]);
  const answer = (asked: PendingQuestion, reply: { answers: AskAnswer[] } | { dismissed: true }) => {
    setAnsweredHere((prev) => new Set(prev).add(asked.toolUseId));
    setSendError(null);
    setAnswerError(null);
    setQuestionGone(null);
    const body = { questions: asked.raw, ...reply };
    (local
      ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/answer`, body)
      : answerCloudQuestion(workspaceId, chatId, body)
    ).catch((error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error ?? "");
      if (isExpiredQuestionError(raw)) {
        // Over already (the session restarted, or it was answered elsewhere):
        // it stays put away, and the composer that is back says so.
        setQuestionGone(`${AGENTS[agent].label} isn't waiting on that question any more. Reply in the chat instead.`);
        return;
      }
      setAnsweredHere((prev) => {
        const next = new Set(prev);
        next.delete(asked.toolUseId);
        return next;
      });
      // The card is up again, so the line sits under it — the composer's send
      // line is hidden with the composer.
      setAnswerError(local ? messageForLocalError(error, agent) : raw || "Couldn't send your answer.");
    });
  };
  const provideSecrets = (asked: PendingSecretRequest, reply: { values: Record<string, string> } | null) => {
    setAnsweredHere((prev) => new Set(prev).add(asked.toolUseId));
    setSendError(null);
    setAnswerError(null);
    setQuestionGone(null);
    setSecretsSaveError(null);
    const keys = asked.keys.map((k) => k.name);
    const body = reply ? { keys, values: reply.values } : { keys, skipped: true };
    (local
      ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/secrets`, body).then(() => null)
      : provideCloudSecrets(workspaceId, chatId, body)
    )
      .then((saveError) => setSecretsSaveError(saveError))
      .catch((error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error ?? "");
        if (isExpiredQuestionError(raw)) {
          setQuestionGone(`${AGENTS[agent].label} isn't waiting for those any more. Reply in the chat instead.`);
          return;
        }
        setAnsweredHere((prev) => {
          const next = new Set(prev);
          next.delete(asked.toolUseId);
          return next;
        });
        setAnswerError(local ? messageForLocalError(error, agent) : raw || "Couldn't send them.");
      });
  };
  // A prompt the stream hasn't recorded yet is a turn starting. The agent
  // refuses a switch mid-turn too, since a turn's end can't be read for sure here.
  // A turn waiting on the user's answer is theirs, not the agent's at work.
  const delivered = userPromptCount(conversation.events);
  const working =
    !waitingOnUser &&
    (compacting ||
      pending.some((p) => pendingShows(p, delivered)) ||
      (!waitingOnPlan && claudeIsWorking(conversation.events) && stoppedAt !== delivered));
  // Prompts sent while the agent is at work wait here (lib/session/prompt-queue.ts)
  // and go one at a time as each turn ends. One whose send failed holds the
  // queue (`queueHeld`) until the user retries it or sends it now, so a box
  // that's down doesn't fail the whole queue in a row.
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queueLoadedFor, setQueueLoadedFor] = useState<string | null>(null);
  const queueRef = useRef<QueuedPrompt[]>([]);
  // Hydration sees the same empty queue as the server. Load before enabling
  // drains, and never overwrite a kept queue with that initial empty snapshot.
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      const saved = readQueue(tabStorage(), stateKey);
      queueRef.current = saved;
      setQueue(saved);
      setQueueLoadedFor(stateKey);
    });
    return () => { live = false; };
  }, [stateKey]);
  useEffect(() => {
    if (queueLoadedFor === stateKey) writeQueue(tabStorage(), stateKey, queue);
  }, [stateKey, queue, queueLoadedFor]);
  const [queueHeld, setQueueHeld] = useState(false);
  // Held by a stop, rather than by a failed send: the user stopped the agent,
  // so what they queued for it waits for them too, until they send another
  // prompt (which goes after it) or send one of them now.
  const [queuePaused, setQueuePaused] = useState(false);
  const sendingQueued = useRef(false);
  const interrupting = useRef(false);
  const [queuedEditing, setQueuedEditing] = useState<{ id: string; words: string } | null>(null);
  // Bumped as each queued send settles, so the queue looks again: the turn it
  // started may have ended while the send was still being answered.
  const [queueSettled, setQueueSettled] = useState(0);
  // The prompts the stream had recorded when the last queued prompt was sent:
  // the next waits until the stream records that one too. A prompt of files
  // alone has no bubble to say the session took it, so `working` alone could
  // let the next go into the same turn.
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const enqueue = (text: string, attachmentIds: string[], queuedMode?: SessionMode): Promise<boolean> => {
    if (queue.length === 0 && queuePaused) {
      // What the stop held has all gone since: this one waits on the turn alone.
      setQueuePaused(false);
      setQueueHeld(false);
    }
    const durable = !!startup || !initialDeliveryComplete;
    const next = [...queueRef.current, { id: crypto.randomUUID(), text, attachmentIds, ...(queuedMode && { mode: queuedMode }), ...(durable && { startup: true }) }];
    // Acknowledging the composer transfers ownership of its files and draft.
    // During startup, persist first so a navigation/reload cannot lose them.
    if (durable && !writeQueue(tabStorage(), stateKey, next)) {
      setSendError({ message: "Couldn't save the queued message in this tab. Your draft is still here; try again." });
      return Promise.resolve(false);
    }
    queueRef.current = next;
    setQueue(next);
    setSendError(null);
    return Promise.resolve(true);
  };
  /** Send a queued prompt now: out of the queue, and back at its head, the
   *  queue held, if it doesn't go (its Retry sends it again). */
  const sendQueued = (prompt: QueuedPrompt): Promise<boolean> => {
    const recorded = prompt.sentAt ?? userPromptCount(eventsRef.current);
    const item = prompt.startup ? { ...prompt, sentAt: recorded } : prompt;
    const next = prompt.startup
      ? queueRef.current.map((p) => p.id === prompt.id ? item : p)
      : queueRef.current.filter((p) => p.id !== prompt.id);
    if (prompt.startup && !writeQueue(tabStorage(), stateKey, next)) {
      setQueueHeld(true);
      setSendError({ message: "Couldn't save this queued message before sending. It is still queued; try again." });
      return Promise.resolve(false);
    }
    queueRef.current = next;
    setQueue(next);
    setQueueHeld(false);
    const how = { ...(prompt.mode && { mode: prompt.mode }), ...(prompt.startup && { queuedKey: prompt.id, sentAt: recorded }) };
    return send(prompt.text, prompt.attachmentIds, () => void sendQueuedNow(item, false), undefined, undefined, how).then((landed) => {
      if (landed) {
        const rest = queueRef.current.filter((p) => p.id !== prompt.id);
        if (prompt.startup) writeQueue(tabStorage(), stateKey, rest);
        queueRef.current = rest;
        setQueue(rest);
        setQueuedAt(recorded);
      }
      else {
        const kept = [item, ...queueRef.current.filter((p) => p.id !== prompt.id)];
        queueRef.current = kept;
        setQueue(kept);
        setQueueHeld(true);
      }
      return landed;
    });
  };
  /** Send a queued prompt in place of the rest of the turn: the turn is
   *  stopped first, and the rest of the queue goes after this one. A stop
   *  that fails leaves it queued, said under the composer. */
  const sendQueuedNow = async (prompt: QueuedPrompt, interrupt = true) => {
    if (queuedEditing || interrupting.current) return;
    const wasHeld = queueHeld;
    const wasPaused = queuePaused;
    const position = queueRef.current.findIndex((item) => item.id === prompt.id);
    setStopError(null);
    try {
      await runQueuedAction(sendingQueued, {
        take: () => {
          if (position < 0) return null;
          if (!prompt.startup) {
            queueRef.current = queueRef.current.filter((item) => item.id !== prompt.id);
            setQueue((q) => q.filter((item) => item.id !== prompt.id));
          }
          setQueueHeld(true);
          setQueuePaused(false);
          return prompt;
        },
        interrupt: async () => { if (interrupt && working) await interruptTurn(); },
        send: sendQueued,
        restore: (item) => {
          setQueue((q) => {
            const next = q.filter((entry) => entry.id !== item.id);
            next.splice(Math.min(position, next.length), 0, item);
            return next;
          });
          setQueueHeld(wasHeld);
          setQueuePaused(wasPaused);
        },
        settled: () => setQueueSettled((n) => n + 1),
      });
    } catch (error) {
      setStopError(local ? messageForLocalError(error, agent) : error instanceof Error ? error.message : "Couldn't stop the turn.");
    }
  };
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  const updateQueue = (change: (q: QueuedPrompt[]) => QueuedPrompt[]): boolean => {
    const next = change(queueRef.current);
    if (queueRef.current.some((p) => p.startup) && !writeQueue(tabStorage(), stateKey, next)) {
      setSendError({ message: "Couldn't save the queue change in this tab. Try again." });
      return false;
    }
    queueRef.current = next;
    setQueue(next);
    return true;
  };
  const removeQueued = (prompt: QueuedPrompt) => {
    if (!updateQueue((q) => q.filter((p) => p.id !== prompt.id))) return;
    // The one that failed sits at the head; with it gone, the rest go on.
    // Not when a stop held them: that holds the rest as well.
    if (queue[0]?.id === prompt.id && !queuePaused) setQueueHeld(false);
    if (queuedEditing?.id === prompt.id) setQueuedEditing(null);
    // Its files were uploaded for it alone.
    for (const id of prompt.sentAt === undefined ? prompt.attachmentIds : []) void fetch(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => {});
  };
  const awaitingLast = queuedAt !== null && delivered <= queuedAt;
  // A prompt the agent took but the stream never shows (Claude dropped it, or a
  // /clear started a new conversation) mustn't hold the queue for good: once
  // the session has sat idle that long since, the wait is over.
  useEffect(() => {
    if (!awaitingLast || working) return;
    const release = setTimeout(() => setQueuedAt(null), QUEUED_ECHO_WAIT_MS);
    return () => clearTimeout(release);
  }, [awaitingLast, working]);
  const drains = queueDrains({
    queued: queue.length,
    attached: attached && initialDeliveryComplete && queueLoadedFor === stateKey,
    working,
    // A plan waiting on approval is answered by the user, not by what's queued.
    waitingOnUser: waitingOnUser || waitingOnPlan,
    held: queueHeld || switching || pendingHarness !== null,
    editing: queuedEditing !== null,
    awaitingLast,
  });
  useEffect(() => {
    if (!drains || sendingQueued.current) return;
    sendingQueued.current = true;
    // After this commit, not inside it: the send sets state of its own.
    const next = queue[0];
    void Promise.resolve()
      .then(() => sendQueued(next))
      .finally(() => {
        sendingQueued.current = false;
        setQueueSettled((n) => n + 1);
      });
    // sendQueued is this render's; the queue's head and whether it drains are
    // what decide a send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drains, queue, queueSettled]);
  // With Claude steering enabled, a mid-turn follow-up goes straight into
  // that turn, ahead of queued messages. Otherwise it waits with the queue.
  // One typed while a plan waits on approval answers it: it closes the plan's
  // menu first, and goes in the mode the composer is in (Plan revises it,
  // Build approves it with changes).
  const sendOrQueue = (text: string, attachmentIds: string[], sentMode?: SessionMode) => {
    if (pendingHarness?.request) return Promise.resolve(false);
    if (pendingHarness) return switchAndSend(text, attachmentIds, false, sentMode);
    if (startup || !initialDeliveryComplete) return enqueue(text, attachmentIds, sentMode);
    if (editing) return sendEdit(editing.uuid, text, attachmentIds, sentMode);
    if (queuePaused) {
      // Sending again is going on: the queue first, then this.
      setQueuePaused(false);
      setQueueHeld(false);
    }
    if (sendingQueued.current || interrupting.current || queuedEditing) return enqueue(text, attachmentIds, sentMode);
    if (waitingOnPlan && plan) return answerPlan(plan.id, text, attachmentIds, { mode: sentMode, dismiss: plan.dismiss });
    // Mid-turn, a follow-up steers the turn (straight in, taken at its next
    // step) where the user has it so and the agent can; else it queues.
    const route = followUpRoute({ working, queued: queue.length, steerFollowUps: chatPreferences.steerFollowUps, agent });
    return route === "queue"
      ? enqueue(text, attachmentIds, sentMode)
      : send(text, attachmentIds, undefined, undefined, undefined, sentMode ? { mode: sentMode } : {});
  };

  /** The edit of a sent message going in its place: the chat's conversation
   *  is cut back to just before it first (POST …/rewind), then the edit goes
   *  as any prompt does, in the same chat. A cut refused (the agent at work)
   *  leaves the edit in the box. */
  const sendEdit = async (uuid: string, text: string, attachmentIds: string[], sentMode?: SessionMode): Promise<boolean> => {
    setSendError(null);
    let cut: RewindResponse;
    try {
      cut = local
        ? RewindResponse.parse(
            await localAgentRequest<unknown>(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/rewind`, { uuid }),
          )
        : await rewindCloudChat(workspaceId, chatId, uuid);
    } catch (error) {
      if ((error instanceof Error && "code" in error && error.code === "INVALID_REQUEST") ||
          (error instanceof LocalRuntimeError && error.code === "agent-invalid-request")) setEditing(null);
      setSendError({ message: local ? messageForLocalError(error, agent) : error instanceof Error ? error.message : "Couldn't edit the message." });
      return false;
    }
    conversation.rewind(cut);
    // What the page counted from the conversation it had (a stop, the echo
    // of a queued send) counts from the one it has now.
    setPending([]);
    setStoppedAt(null);
    setQueuedAt(null);
    setEditing(null);
    return send(text, attachmentIds, undefined, undefined, undefined, sentMode ? { mode: sentMode } : {});
  };
  /** Answer the plan waiting on approval with a prompt: its card's buttons
   *  are put away while it goes, and back if it doesn't. */
  const answerPlan = (id: string, text: string, attachmentIds: string[], how: SendHow): Promise<boolean> => {
    setAnsweredHere((prev) => new Set(prev).add(id));
    const again = (): void => void answerPlan(id, text, attachmentIds, how);
    return send(text, attachmentIds, again, undefined, undefined, how).then((landed) => {
      if (!landed)
        setAnsweredHere((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      return landed;
    });
  };
  /** Approve the plan: the agent picks the session's build mode in Claude's
   *  own plan menu, so Claude goes on in the same turn (else it sends the
   *  approval as a prompt in build mode: Codex's). The card's buttons are put
   *  away while it goes, and back if it doesn't. */
  const approvePlan = (id: string) => {
    setAnsweredHere((prev) => new Set(prev).add(id));
    setSendError(null);
    (local
      ? localAgentRequest<unknown>(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/plan`, { action: "approve" }).then(
          (raw) => PlanActionResponse.parse(raw),
        )
      : approveCloudPlan(workspaceId, chatId)
    ).then(
      (outcome) => {
        // Building from here, once the agent says so: an approval that didn't
        // go leaves the composer planning, so what's typed next revises.
        if (outcome.result === "approved") return setMode("build");
        // Answered already (another tab, the terminal): the card stays put
        // away, and the toggle takes the mode the agent read off the screen.
        const now = outcome.mode ?? "build";
        setMode(now);
        setNote(`This plan was answered already, so ${AGENTS[agent].label} is ${now === "build" ? "building" : "still planning"}.`);
      },
      (error: unknown) => {
        setAnsweredHere((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setSendError({
          message: local ? messageForLocalError(error, agent) : error instanceof Error ? error.message : "Couldn't approve the plan.",
        });
      },
    );
  };
  const [reviseSignal, setReviseSignal] = useState(0);
  // A sent message being edited (its pencil): its text in the composer,
  // which sends the edit in its place.
  const [editing, setEditing] = useState<{ uuid: string; text: string } | null>(null);
  const editMessage = (uuid: string, text: string) => {
    setEditing({ uuid, text });
    setReviseSignal((n) => n + 1);
  };
  const planActions =
    plan && waitingOnPlan
      ? {
          id: plan.id,
          onApprove: () => approvePlan(plan.id),
          onRevise: () => {
            setMode("plan");
            setReviseSignal((n) => n + 1);
          },
        }
      : null;

  /** /compact: the agent compacts the conversation; the session is busy
   *  until the stream shows it done. Resolves whether it started. */
  const compact = (instructions: string): Promise<boolean> => {
    setSendError(null);
    setNote(null);
    const from = eventsRef.current.length;
    // Codex's /compact takes no instructions (its agent leaves them off):
    // compact all the same, and say they weren't used.
    const dropped = agent === "codex" && instructions !== "";
    const body = instructions && !dropped ? { instructions } : {};
    return whenAttached()
      .then(() =>
        local
          ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/compact`, body).then(() => undefined)
          : compactCloudSession(workspaceId, chatId, body),
      )
      .then(
        () => {
          setCompactingFrom(from);
          if (dropped) setNote("Codex's /compact doesn't take instructions, so it compacted without them.");
          return true;
        },
        (error: unknown) => {
          setSendError({
            message: local ? messageForLocalError(error, agent) : error instanceof Error ? error.message : "Couldn't compact the conversation.",
          });
          return false;
        },
      );
  };
  // Comments on the diff (the Changes view's) go with the composer's next
  // message, as quotes after its text. Only the ones it carried are cleared,
  // once it has gone or joined the queue; a failed send keeps them for the next.
  const diffComments = useDiffComments(workspaceId);
  const sendWithComments = (text: string, attachmentIds: string[], sentMode?: SessionMode) => {
    const carried = diffComments.items;
    if (carried.length === 0) return sendOrQueue(text, attachmentIds, sentMode);
    return sendOrQueue(withComments(text, carried), attachmentIds, sentMode).then((landed) => {
      if (landed) diffComments.clear(carried.map((c) => c.id));
      return landed;
    });
  };

  const interruptTurn = async () => {
    if (interrupting.current) throw new Error("This turn is already being stopped.");
    interrupting.current = true;
    setStopping(true);
    try {
      await (local
        ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/interrupt`)
        : stopCloudTurn(workspaceId, chatId));
      setStoppedAt(userPromptCount(eventsRef.current));
      setQueuedAt(null);
      setPending(pendingAfterStop);
    } finally {
      interrupting.current = false;
      setStopping(false);
    }
  };
  const stop = () => {
    if (interrupting.current) return;
    setSendError(null);
    setStopError(null);
    // What's queued stays queued: the stop was for the agent's work, not for
    // the next prompt to start it again at once. Held before the stop goes,
    // not once it is answered: the stream may say the turn is over first,
    // and the queue would drain into the gap.
    const hadQueue = queueRef.current.length > 0;
    // As they were, for a stop that fails: a hold a failed send put on the
    // queue stays, its Retry still to come.
    const wasHeld = queueHeld;
    const wasPaused = queuePaused;
    if (hadQueue) {
      setQueueHeld(true);
      setQueuePaused(true);
    }
    void interruptTurn()
      .catch((error: unknown) => {
        // The turn goes on, and the queue with it, as it was.
        if (hadQueue) {
          setQueueHeld(wasHeld);
          setQueuePaused(wasPaused);
        }
        setStopError(
          local ? messageForLocalError(error) : error instanceof Error ? error.message : "Couldn't stop the turn.",
        );
      });
  };
  // Escape stops the turn from anywhere in the session, not only the
  // composer's box: a click in the conversation takes the focus out of it.
  // Not from another field (it has its own Escape), nor one already taken
  // (a menu, a dialog, the composer's own).
  const stopNow = attached && working ? { onStop: stop, stopping } : undefined;
  const sessionRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(stopNow);
  useEffect(() => {
    stopRef.current = stopNow;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inField = target?.closest("input, textarea, select, [contenteditable=true]");
      const inSession = !target || target === document.body || sessionRef.current?.contains(target);
      if (event.key !== "Escape" || event.defaultPrevented || inField || !inSession || event.isComposing) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      const current = stopRef.current;
      if (!current || current.stopping) return;
      event.preventDefault();
      current.onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The session's files for the composer's @ mentions: from its agent, on
   *  this Mac or through the server. The Mac's app relays only the routes it
   *  knows, and one installed before this relays no `files`: there, the
   *  change set it does relay stands in, as the server's route does for an
   *  agent from before it. */
  const listFiles = useCallback(
    (): Promise<FilesResponse> =>
      local
        ? localAgentRequest<unknown>(localTarget(workspaceId), "GET", `/workspaces/${workspaceId}/files`).then(
            (raw) => FilesResponse.parse(raw),
            (error: unknown) => {
              // Only an app that doesn't relay the listing: a real failure (git,
              // a timeout, a runner that's down) is said as one.
              if (!(error instanceof LocalRuntimeError && error.code === "route-not-allowed")) throw error;
              return localAgentRequest<unknown>(localTarget(workspaceId), "GET", `/workspaces/${workspaceId}/changes`).then(
                (raw) => changedOnly(ChangesResponse.parse(raw).files),
              );
            },
          )
        : fetch(`/api/workspaces/${workspaceId}/files`).then(async (res) => {
            if (!res.ok) throw new Error("Couldn't list this session's files.");
            return FilesResponse.parse(await res.json());
          }),
    [local, workspaceId],
  );

  // The user's own accounts this session can switch to. A local session's
  // agent is already running on this Mac, so its own login there counts.
  const accounts = accountsHere(menu.agents, local, null);
  const pickerAgent = pendingHarness?.agent ?? agent;
  const switchAndSend = async (text: string, attachmentIds: string[], resume: boolean, sentMode?: SessionMode): Promise<boolean> => {
    if (!pendingHarness || harnessSending.current) return false;
    const operation: PendingHarness = { ...pendingHarness, request: pendingHarness.request ?? { content: text, attachmentIds, resume, mode: sentMode ?? mode } };
    if (!keepHarness(operation)) {
      setSwitchError({ label: "Harness", message: "Couldn't save the pending switch in this tab. Your draft is still here." });
      return false;
    }
    harnessSending.current = true;
    setSwitching(true);
    setSwitchError(null);
    try {
      const selected = operation.selection as RecordedModel;
      const response = await fetch(chatRoute(workspaceId, chatId, "harness"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: operation.id, agent: operation.agent, expectedAgent: operation.expectedAgent,
          provider: selected.model.provider, model: selected.model.id, effort: selected.effort,
          ...operation.request }),
      });
      const data = await response.json() as { agent: AgentId; recorded: RecordedModel; operationId: string; error?: string; sourceUnchanged?: boolean };
      if (!response.ok) {
        if (data.sourceUnchanged) keepHarness({ ...operation, request: undefined });
        throw new Error(data.error ?? "Couldn't change harness. Retry to finish this switch.");
      }
      setActiveSelection({ agent: data.agent, recorded: data.recorded, operationId: data.operationId });
      setProviderPicked(data.recorded.model.provider);
      setEffortHere(data.recorded.effort);
      setPicked({ model: data.recorded.model.id, events: eventsRef.current.length });
      if (operation.request && !operation.request.resume) {
        const sent = operation.request;
        DRAFTS.update(`ws:${stateKey}`, (draft) => draft.text === sent.content &&
          draft.attachments.length === sent.attachmentIds.length && draft.attachments.every((item) => item.id && sent.attachmentIds.includes(item.id))
          ? { text: "", attachments: [] } : draft);
      }
      keepHarness(null);
      setQueuePaused(false);
      setQueueHeld(false);
      conversation.refresh();
      return true;
    } catch (error) {
      setSwitchError({ label: AGENTS[operation.agent].label, message: error instanceof Error ? error.message : "Couldn't change harness. Retry to finish this switch." });
      return false;
    } finally { harnessSending.current = false; setSwitching(false); }
  };
  const modelChoice: ModelChoice = {
    groups: modelGroups(local ? (menu.localMenu ?? { ...menu, keys: [], codexModels: [] }) : menu, accounts, pickerAgent),
    agent: pickerAgent,
    selectedModel: pendingHarness?.selection.model as SessionModel | undefined ?? matchModel(modelGroups(menu, accounts, agent), shownModel, providerPicked ?? recorded?.model.provider)
      ?? (recorded && recorded.model.id === shownModel ? recorded.model : undefined),
    harnessChoice: allowHarnessSwitch && !local ? {
      available: [...new Set([agent, ...eligibleHarnesses(modelGroups(menu, accounts), menu.harnesses)])],
      disabledReason: "Choose a harness and model, then send to continue this chat with its history and files.",
      onChange: (next) => {
        if (switching || pendingHarness?.request) return;
        if (next === agent) { keepHarness(null); return; }
        const selected = selectionForHarness(modelGroups(menu, accounts), menu.loadout, next);
        if (!selected) return;
        keepHarness({ id: crypto.randomUUID(), agent: next, expectedAgent: agent, selection: { model: selected.model, effort: selected.effort } });
      },
    } : { available: [agent], disabledReason: "Harness changes are available once a cloud chat is connected. Start a new session to change a local session's harness." },
    // The session's own agent's account, where it isn't connected here.
    connect: accounts.includes(pickerAgent) ? [] : [pickerAgent],
    effort: pendingHarness ? pendingHarness.selection.effort : effort,
    loadout: menu.loadout,
    preferredProvider: providerPicked ?? recorded?.model.provider ?? defaultModel(menu)?.provider,
    switching,
    disabledReason: pendingHarness?.request
      ? "Retry the pending harness switch before changing selection"
      : editing || queuedEditing
      ? "Finish or cancel editing the prompt before changing selection"
      : !attached
      ? "Waiting for the session to connect"
      : !initialDeliveryComplete || queue.some((prompt) => prompt.startup)
        ? "Finish sending or remove the queued startup messages before changing selection"
      : waitingOnUser
        ? waitingOnSecrets
          ? `Answer ${AGENTS[agent].label}'s request first`
          : `Answer ${AGENTS[agent].label}'s question first`
        : working && !allowHarnessSwitch
          ? `Switch models once ${AGENTS[agent].label} has finished this turn`
          : null,
    onChange: (model, pickedEffort) => {
      if (pendingHarness) {
        keepHarness({ ...pendingHarness, id: crypto.randomUUID(), selection: { model, effort: compatibleEffort(model, pickedEffort) } });
        return;
      }
      // What the agent is told: an effort goes only with a model that takes one.
      const next = compatibleEffort(model, pickedEffort);
      setSwitching(true);
      setSendError(null);
      setSwitchError(null);
      // A local switch relaunches the session on this Mac: signed in as the
      // user picks now first, as the server does for a cloud one.
      (local
        ? deliverLocalAgentAuth(workspaceId, agent, runsOnOwnAccount(model)).then(() => putOnModel(workspaceId, model, next))
        : switchCloudModel(workspaceId, chatId, model, next))
        .then(() => {
          setPicked({ model: model.id, events: conversation.events.length });
          setProviderPicked(model.provider);
          rememberPickedProvider(stateKey, model.provider);
          setEffortHere(next);
          rememberEffort(stateKey, next);
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
      .filter((p) => pendingShows(p, delivered))
      .map<AgentEvent>((p) => ({
        t: "message",
        uuid: echoUuid(p.id),
        parentUuid: null,
        role: "user",
        timestamp: new Date().toISOString(),
        // Its files named as the server will name them, so it shows them as
        // the logged prompt will, from this page's own copies.
        content: [{ type: "text", text: echoText(p) }],
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
        const title = body.titled ? sessionTitle(firstPrompt) : null;
        if (title) patchRowAhead(workspaceId, { title });
      })
      .catch(() => {
        /* cosmetic: the session keeps its branch name until the next prompt */
      });
  }, [firstPrompt, workspaceId]);

  // Fire the new session's first prompt exactly once, as soon as we hold the
  // keyboard: the one the URL carries, else the one kept for this session
  // while its box was set up (lib/session/first-prompt.ts).
  const sentInitial = useRef(false);
  // The first prompt gone or settled: forget the kept copy, and the URL's
  // params while `path`, the session's page, is still the page. Its settling
  // can come after a send that waited on the session, by when the user may be
  // on another session, whose URL may be its own first prompt's only copy.
  const forgetFirstPromptOn = (path: string | null) => {
    if (!local) forgetFirstPrompt(tabStorage(), workspaceId);
    if (path !== null && window.location.pathname === path) dropFirstPromptFromAddressBar();
  };
  // The page a cut-off first prompt was offered on.
  const cutOffPath = useRef<string | null>(null);
  // The first prompt a reload cut off mid-send, while the conversation hasn't
  // shown it. Only once the stream is live: until then the events are the
  // copy kept from before the reload, which seldom has the prompt yet, and a
  // Send it again offered then would most often be for a prompt that went.
  const [cutOff, setCutOff] = useState<FirstPrompt | null>(null);
  const cutOffShown =
    cutOff && conversation.status === "connected" && userPromptCount(conversation.events) === 0 ? cutOff : null;
  // The cut-off prompt is kept (marked going, and in the URL) until it's
  // settled: sent again and landed, dismissed, or shown by the conversation
  // (the cut-off send got there). Forgotten as soon as it was offered, a
  // second reload before any of those, after a send the server had let go,
  // left it nowhere: never sent, and never offered again.
  const settleCutOff = () => {
    forgetFirstPromptOn(cutOffPath.current);
    setInitialDeliveryComplete(true);
  };
  const cutOffLanded = cutOff !== null && conversation.status === "connected" && userPromptCount(conversation.events) > 0;
  useEffect(() => {
    if (cutOffLanded) void Promise.resolve().then(settleCutOff);
    // settleCutOff reads only props that don't change for this session, and a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutOffLanded]);
  useEffect(() => {
    if (sentInitial.current || !attached) return;
    const fromUrl: FirstPrompt = {
      prompt: initialPrompt ?? "",
      attachmentIds: initialAttachmentIds ?? [],
      ...(initialPromptKey && { key: initialPromptKey }),
    };
    // The server's kept copy is the last resort, and only a cloud session's:
    // its row is where setup read the prompt it may have delivered already,
    // in which case this send answers "already" and cleans up after it.
    const first = hasFirstPrompt(fromUrl)
      ? fromUrl
      : local
        ? null
        : (rememberedFirstPrompt(tabStorage(), workspaceId) ?? storedFirstPrompt);
    if (!first) {
      void Promise.resolve().then(() => setInitialDeliveryComplete(true));
      return;
    }
    sentInitial.current = true;
    // send() queues an optimistic bubble (setState); this is a one-time guarded
    // fire on ready, not a render cascade. Another mount of this session may be
    // sending it still: sendFirstPromptOnce waits on that one instead.
    const sessionPath = window.location.pathname;
    // The prompt went: forget the kept copy, and the URL's params (only while
    // this session is still the page), so a reload can't send it again.
    // Nothing is forgotten until the POST is accepted, so a failed delivery
    // leaves it in place for a retry or a reload.
    const itWent = () => forgetFirstPromptOn(sessionPath);
    // A page before a reload had sent it, and the reload cut that send off
    // before it could forget it: it most likely reached Claude, so it isn't
    // sent again (firstPromptCutOff). It is said, with a way to send it, until
    // the conversation shows a prompt, so a send that never got there costs
    // a click rather than the prompt; and kept until then (settleCutOff).
    if (!local && firstPromptCutOff(tabStorage(), workspaceId)) {
      // Once, on ready, behind the same guard as the send: storage is read
      // here and nowhere a render could.
      cutOffPath.current = sessionPath;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCutOff(first);
      return;
    }
    // Send it, cleaning up only once it lands. A failed send keeps its Retry.
    // The kept copy is marked going as the request itself leaves, not while
    // it waits on the session, so a reload mid-request finds it marked; any
    // failure, the route's own included, puts it back to waiting.
    const attempt = (): Promise<boolean> =>
      send(
        first.prompt,
        first.attachmentIds,
        retry,
        () => {
          if (!local) markFirstPromptGoing(tabStorage(), workspaceId, true);
        },
        first.key,
      ).then((landed) => {
        if (landed) {
          itWent();
          setInitialDeliveryComplete(true);
        }
        else if (!local) markFirstPromptGoing(tabStorage(), workspaceId, false);
        return landed;
      });
    // The composer's Retry re-enters through the same once-per-tab gate as
    // the first try, so a retry racing a remounted page still sends it once.
    const retry = (): void => void sendFirstPromptOnce(workspaceId, attempt);
    void sendFirstPromptOnce(workspaceId, attempt).then((outcome) => {
      // Another page of this tab sent it first: its send cleaned up after
      // itself, but this URL may still be the one carrying the prompt.
      if (outcome === "already") {
        itWent();
        setInitialDeliveryComplete(true);
      }
    });
    // send is stable enough; guard prevents a repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, initialPrompt, initialPromptKey, initialAttachmentIds, storedFirstPrompt]);

  return (
    <div ref={sessionRef} className="studio-live-session min-w-0" data-testid="workspace-session">
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
      {stopError && !connectionError && !streamDropped && (
        <Notice
          tone="error"
          title="Couldn't stop this turn"
          detail={`${stopError} The turn keeps running.`}
          actions={[{ label: "Dismiss", onClick: () => setStopError(null) }]}
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

      <section className="studio-convo-panel" aria-label={`${AGENTS[agent].label} conversation`}>
        <div className="studio-convo-body">
          {/* Images Claude shows by path are on a cloud session's box; this
              Mac's are out of the server's reach. */}
          <ImageBoxContext value={local ? null : workspaceId}>
            {startup && firstQueued ? <QueuedFirstPrompt first={firstQueued} /> : <ConversationTimeline
              agentLabel={AGENTS[agent].label}
              events={timelineEvents}
              working={working && !compacting}
              compacting={compacting}
              plansInProse={agent === "codex"}
              plan={planActions}
              // Only between turns: an edit cuts the conversation under the
              // agent, which must not be writing to it.
              onEdit={attached && !boundary && !working && !waitingOnUser && !waitingOnPlan ? editMessage : undefined}
              placeholder={startup ? null : conversationPlaceholder({
                events: timelineEvents,
                attachment: attachment.status,
                stream: conversation.status,
              })}
            />}
          </ImageBoxContext>
        </div>
      </section>

      {startup && <StartupStatus startup={startup} />}
      {question && (
        <QuestionCard
          key={question.toolUseId}
          question={question}
          agentLabel={AGENTS[agent].label}
          hidden={!waitingOnUser}
          onAnswer={(answers) => answer(question, { answers })}
          onDismiss={() => answer(question, { dismissed: true })}
        />
      )}
      {secretRequest && (
        <SecretsCard
          key={secretRequest.toolUseId}
          request={secretRequest}
          agentLabel={AGENTS[agent].label}
          canSave={!local}
          hidden={!waitingOnSecrets}
          onProvide={(values) => provideSecrets(secretRequest, { values })}
          onSkip={() => provideSecrets(secretRequest, null)}
        />
      )}
      {secretsSaveError ? (
        <InlineMessage tone="warning" actions={[{ label: "Dismiss", onClick: () => setSecretsSaveError(null) }]}>
          {secretsSaveError}
        </InlineMessage>
      ) : null}
      {(question || secretRequest) && answerError ? (
        // An answer that didn't go is the card's failure to say, not the
        // composer's: the composer is away while the card is up.
        <InlineMessage>{answerError}</InlineMessage>
      ) : null}
      {!waitingOnUser && cutOffShown ? (
        <InlineMessage
          tone="info"
          actions={[
            {
              label: "Send it again",
              onClick: () => {
                setCutOff(null);
                // Its own Retry, so a resend that fails keeps the prompt.
                // Under the prompt's own key: if the cut-off send got there
                // after all, the server answers as sent and sends nothing.
                const { prompt, attachmentIds, key } = cutOffShown;
                const again = (): void =>
                  void send(prompt, attachmentIds, again, undefined, key).then((landed) => {
                    if (landed) settleCutOff();
                  });
                again();
              },
            },
            {
              label: "Dismiss",
              onClick: () => {
                setCutOff(null);
                settleCutOff();
              },
            },
          ]}
        >
          Your first message was on its way when the page reloaded. If it doesn&apos;t show up, send it again.
        </InlineMessage>
      ) : null}
      {note ? (
        <InlineMessage tone="info" actions={[{ label: "Dismiss", onClick: () => setNote(null) }]}>
          {note}
        </InlineMessage>
      ) : null}
      {!waitingOnUser && questionGone ? (
        <InlineMessage tone="info" actions={[{ label: "Dismiss", onClick: () => setQuestionGone(null) }]}>
          {questionGone}
        </InlineMessage>
      ) : null}
      {!waitingOnUser && (
        <QueuedPrompts
          queue={queue}
          working={working}
          canSendNow={attached && initialDeliveryComplete && !stopping}
          editing={queuedEditing}
          onEditingChange={(next) => {
            if (next && sendingQueued.current) return;
            setQueuedEditing(next);
          }}
          paused={queuePaused && queue.length > 0}
          starting={!!startup || !initialDeliveryComplete}
          onSteer={(prompt) => void sendQueuedNow(prompt, false)}
          onSendNow={(prompt) => void sendQueuedNow(prompt)}
          onEdit={(prompt, words) => { updateQueue((q) => editQueued(q, prompt.id, words)); }}
          onMove={(prompt, by) => { updateQueue((q) => moveQueued(q, prompt.id, by)); }}
          onRemove={removeQueued}
        />
      )}
      {!waitingOnUser && (
        <>
        {allowHarnessSwitch && exhaustion(conversation.events) && !pendingHarness && <InlineMessage tone="info">{AGENTS[agent].label} reached its {exhaustion(conversation.events) === "credits" ? "credit" : "usage"} limit. Choose another connected harness below to continue this chat.</InlineMessage>}
        {pendingHarness && <InlineMessage tone="info" actions={pendingHarness.request ? [{ label: "Retry switch", onClick: () => { void switchAndSend("", [], false); } }] : [
          ...(hasUnfinishedRequest(conversation.events) ? [{ label: "Switch & resume", onClick: () => { void switchAndSend("", [], true); } }] : []),
          { label: "Cancel", onClick: () => { keepHarness(null); } },
        ]}>
          {switching ? "Handing over the conversation…" : `${AGENTS[agent].label} → ${AGENTS[pendingHarness.agent].label}. ${pendingHarness.request ? "Retry to finish the saved switch." : "Your next message will continue this chat on the selected harness."}`}
        </InlineMessage>}
        <SessionComposer
          // Kept while a question or secrets card stands in for it, too.
          draftKey={`ws:${stateKey}`}
          onSend={sendWithComments}
          comments={{ items: diffComments.items, onRemove: diffComments.remove }}
          modeChoice={{ mode, onChange: setMode }}
          onCompact={startup ? undefined : compact}
          onSideChat={onSideChat}
          context={contextNow}
          // Sent as itself, without the diff's comments, and only while no
          // edit, plan, switch or queue would take the send over.
          onContextReport={
            contextReportOffered({
              agent,
              starting: Boolean(startup) || !initialDeliveryComplete || queuedEditing !== null,
              working,
              waitingOnUser: waitingOnUser || waitingOnPlan,
              editing: editing !== null,
              switchingHarness: pendingHarness !== null,
              queued: queue.length,
            })
              ? () => void send("/context")
              : undefined
          }
          focusSignal={reviseSignal}
          editing={editing && { key: editing.uuid, text: editing.text, onCancel: () => setEditing(null) }}
          placeholder={
            startup ? "Queue a message while your session starts…" : waitingOnPlan
              ? `Tell ${AGENTS[agent].label} what to change in the plan…`
              : working
                ? followUpRoute({ working, queued: queue.length, steerFollowUps: chatPreferences.steerFollowUps, agent }) === "steer"
                  ? `Steer ${AGENTS[agent].label}: it takes your message at its next step…`
                  : "Queue a message for when this turn ends…"
                : mode === "plan"
                  ? `Ask ${AGENTS[agent].label} to plan something…`
                  : undefined
          }
          canSend={canSend}
          // Sending waits on the connection alone, so say that, not the
          // composer's default (another viewer holding the keyboard).
          disabledPlaceholder={
            attachment.status === "error" ? "You can send once this session is back." : "Connecting to this session…"
          }
          model={shownModel}
          modelChoice={modelChoice}
          sendDisabledReason={switching ? "Wait for the harness or model change to finish" : pendingHarness?.request ? "Use Retry switch to finish the saved request. Your draft is kept." : undefined}
          allowAttachments={!local}
          sendError={connectionError ? null : (sendError?.message ?? null)}
          sendErrorNoRetry={sendIsDeadEnd(sendError?.code)}
          newSessionHref={projectId ? `/new?project=${projectId}` : "/new"}
          onDismissSendError={() => setSendError(null)}
          onRetrySendError={sendError?.retry}
          stop={stopNow}
          listFiles={startup ? undefined : listFiles}
        />
        </>
      )}
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
  if (code === BOX_GONE) {
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
  if (code === SESSION_ENDED) {
    // Archived or deleted in another tab, by an automation or a Mission: the
    // page reloaded shows it as it is now (an archived one with Restore).
    // Retrying here would only be refused again.
    return (
      <Notice
        tone="warning"
        title="This session was archived or deleted elsewhere"
        detail={message ?? "It ended since this page loaded."}
        actions={[{ label: "Reload", icon: <RotateCw />, primary: true, onClick: () => window.location.reload() }]}
      />
    );
  }
  if (code === SESSION_NOT_STARTED) {
    return (
      <Notice
        tone="error"
        title="This session's agent didn't start"
        detail={message ?? "Its box is up, but the agent on it didn't start."}
        actions={[retry("Try again")]}
      />
    );
  }
  if (code === BOX_RESTORE_FAILED) {
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
  // Seeded from the clock, not `since`: the first second shows the run's real
  // elapsed time rather than a 0:00 that jumps on the next tick.
  const [now, setNow] = useState(() => Date.now());
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
async function switchCloudModel(workspaceId: string, chatId: string, model: SessionModel, effort: Effort | null): Promise<void> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: model.provider, model: model.id, ...(effort && { effort }) }),
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

/** Answer the questions a cloud session's agent is waiting on. The server
 *  reaches the session's agent, as for a prompt. */
async function answerCloudQuestion(workspaceId: string, chatId: string, body: unknown): Promise<void> {
  const res = await fetch(chatRoute(workspaceId, chatId, "answer"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "Couldn't send your answer. Please try again.");
}

/** Send the secrets a cloud session's agent asked for. The server reaches
 *  the session's agent, as for an answer. Resolves with why they weren't
 *  saved to the project, when they were meant to be and weren't. */
async function provideCloudSecrets(workspaceId: string, chatId: string, body: unknown): Promise<string | null> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "secrets"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; saveError?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't send them. Please try again.");
  return data.saveError ?? null;
}

/** Approve the plan a cloud session's agent waits on. The server reaches the
 *  session's agent, as for a prompt. */
async function approveCloudPlan(workspaceId: string, chatId: string): Promise<PlanActionResponse> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "plan"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (res.ok) return PlanActionResponse.parse(data);
  throw new Error((data as { error?: string }).error ?? "Couldn't approve the plan. Please try again.");
}

/** Compact a cloud session's conversation. The server reaches the session's
 *  agent, as for a prompt. */
async function compactCloudSession(workspaceId: string, chatId: string, body: { instructions?: string }): Promise<void> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "compact"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "Couldn't compact the conversation. Please try again.");
}

/** Cut a cloud chat's conversation back to just before its prompt `uuid`,
 *  for its edit to go in its place. */
async function rewindCloudChat(workspaceId: string, chatId: string, uuid: string): Promise<RewindResponse> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "rewind"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid }),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (res.ok) return RewindResponse.parse(data);
  throw Object.assign(new Error((data as { error?: string }).error ?? "Couldn't edit the message. Please try again."), { code: (data as { code?: string }).code });
}

/** Stop a cloud session's turn. The server reaches the session's agent, as
 *  for a prompt. */
async function stopCloudTurn(workspaceId: string, chatId: string): Promise<void> {
  const res = await reachOutrunner(chatRoute(workspaceId, chatId, "interrupt"), { method: "POST" });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "Couldn't stop the turn. Please try again.");
}

/** A bubble's prompt as the session will log it: with its files' header
 *  (promptWithAttachments), named from what this page knows of them. */
function echoText(pending: PendingPrompt): string {
  const ids = pending.attachmentIds ?? [];
  if (ids.length === 0) return pending.text;
  const known = ids.map((id) => ({ id, preview: previewOf(id) }));
  const names = attachmentFilenames(known.map(({ id, preview }) => ({ id, filename: preview?.filename ?? "attachment" })));
  return promptWithAttachments(
    pending.text,
    names.map((name, i) => ({ name, image: known[i].preview ? known[i].preview.url !== null : false })),
  );
}
