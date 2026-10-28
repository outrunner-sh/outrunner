"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { ConversationTimeline } from "@/components/conversation-timeline";
import { ImageBoxContext } from "@/components/markdown";
import { QueuedPrompts } from "@/components/queued-prompts";
import { QuestionCard } from "@/components/question-card";
import { pendingSecretRequest, type PendingSecretRequest } from "@/lib/runtime/pending-secrets";
import { SecretsCard } from "@/components/secrets-card";
import { SessionComposer, type ModelChoice } from "@/components/session-composer";
import { ErrorRef, InlineMessage, Notice, TickingFact } from "@/components/ui/notice";
import { deliverLocalAgentAuth, LocalAgentAuthError } from "@/lib/desktop/local-agent-auth";
import {
  LOCAL_RUNNER_LOG,
  accountsHere,
  localAgentRequest,
  localTarget,
  localSendFailure,
  messageForLocalError,
  putOnModel,
  runnerDidNotStartDetail,
} from "@/lib/desktop/local-runtime";
import { claudeIsWorking, firstUserPrompt, userPromptCount, userPrompts } from "@/lib/runtime/conversation-events";
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
import { isProviderId } from "@/lib/providers/registry";
import { EMPTY_LOADOUT } from "@/lib/runtime/model-loadout";
import {
  defaultModel,
  type Effort,
  modelGroups,
  type ModelProvider,
  parseAgentConnections,
  type RecordedModel,
  runsOnOwnAccount,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";
import { rememberedEffort, rememberEffort } from "@/lib/session/picked-effort";
import { type QueuedPrompt, queueDrains, readQueue, writeQueue } from "@/lib/session/prompt-queue";
import { sendIsDeadEnd } from "@/lib/session/send-failure";
import { BOX_GONE, BOX_RESTORE_FAILED } from "@/lib/session/session-codes";
import type { OutrunnerModels } from "@/lib/desktop/local-runtime";
import { useOutrunnerModels } from "@/hooks/use-outrunner-models";
import { useConversationStream } from "@/hooks/use-conversation-stream";
import { useSessionAttachment } from "@/hooks/use-session-attachment";

/** A send that didn't go: why, and how to try it again. `retry` is set only
 * where its text never was in the composer's box (a session's first prompt),
 * so the box's Retry sends the original rather than an empty box. `code` is
 * the route's, when it gave one, so a dead end offers no retry. */
type FailedSend = { message: string; retry?: () => void; code?: string };

/** How long the queue waits, the session idle, for the stream to record the
 *  last queued prompt sent before sending the next anyway. */
const QUEUED_ECHO_WAIT_MS = 30_000;

const MENU_UNTIL_ANSWERED: OutrunnerModels = {
  outrunner: true,
  allowance: false,
  keys: [],
  available: true,
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
  projectId,
  agent = "claude",
  recorded = null,
  local = false,
  untitled = false,
  initialPrompt,
  initialPromptKey,
  initialAttachmentIds,
  onSender,
}: {
  workspaceId: string;
  /** Its repository, so a session whose box is gone can continue in a new one there. */
  projectId?: string;
  /** The coding agent the session runs: its model menu offers only models
   *  that agent runs. */
  agent?: AgentId;
  /** The model and effort its row records it was last put on (a cloud
   *  session's), shown until a reply or a pick here says otherwise. */
  recorded?: RecordedModel | null;
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
  /** Given a sender while the session can send, null when it no longer can:
   *  for prompts from outside the composer (Create PR). Must be stable. */
  onSender?: (sender: SessionSender | null) => void;
}) {
  const router = useRouter();
  const attachment = useSessionAttachment(workspaceId, local, agent);
  const conversation = useConversationStream(attachment, workspaceId);

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
  ) => {
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
        return deliver(text, attachmentIds, pendingId, failed, firstPromptKey);
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
  ) => {
    // The stream may record the prompt before the session answers.
    const sentAt = userPromptCount(eventsRef.current);
    if (local) {
      return localAgentRequest(
        localTarget(workspaceId),
        "POST",
        `/workspaces/${workspaceId}/message`,
        { content: text },
      ).then(
        () => {
          anchor(pendingId, sentAt);
          return true;
        },
        (error: unknown) => failed(localSendFailure(error)),
      );
    }
    return fetch(`/api/workspaces/${workspaceId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, attachmentIds, ...(firstPromptKey && { firstPromptKey }) }),
    }).then(
      async (res) => {
        const body = (await res.json().catch(() => ({}))) as { titled?: boolean; error?: string; code?: string };
        if (!res.ok) return failed(body.error ?? "Could not send that message.", body.code);
        anchor(pendingId, sentAt);
        // The first prompt just named this session: re-read the sidebar.
        if (body.titled) router.refresh();
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
    if (!canSend || !onSender) return;
    onSender({ send: (text, attachmentIds) => sendRef.current(text, attachmentIds) });
    return () => onSender(null);
  }, [canSend, onSender]);

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
  // The effort it runs at, as last put on from here (lib/session/picked-effort.ts);
  // none put on from here (a session started from onboarding, or another
  // browser), as its row records. Undefined until either says.
  const [effortHere, setEffortHere] = useState<Effort | null | undefined>(
    () => rememberedEffort(workspaceId) ?? undefined,
  );
  const effort = effortHere !== undefined ? effortHere : (recorded?.effort ?? null);
  const repliedSincePick =
    picked !== null &&
    conversation.events
      .slice(picked.events)
      .some((event) => event.t === "message" && event.role === "assistant" && event.model);
  // Before its first reply, the model its row records it starts on.
  const shownModel = picked && !repliedSincePick ? picked.model : (activeModel ?? recorded?.model.id);
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
  const waitingOnSecrets = secretRequest !== null && !answeredHere.has(secretRequest.toolUseId);
  const [secretsSaveError, setSecretsSaveError] = useState<string | null>(null);
  const waitingOnUser = (question !== null && !answeredHere.has(question.toolUseId)) || waitingOnSecrets;
  const answer = (asked: PendingQuestion, reply: { answers: AskAnswer[] } | { dismissed: true }) => {
    setAnsweredHere((prev) => new Set(prev).add(asked.toolUseId));
    setSendError(null);
    setAnswerError(null);
    setQuestionGone(null);
    const body = { questions: asked.raw, ...reply };
    (local
      ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/answer`, body)
      : answerCloudQuestion(workspaceId, body)
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
  const provideSecrets = (asked: PendingSecretRequest, reply: { values: Record<string, string>; save: boolean } | null) => {
    setAnsweredHere((prev) => new Set(prev).add(asked.toolUseId));
    setSendError(null);
    setAnswerError(null);
    setQuestionGone(null);
    setSecretsSaveError(null);
    const keys = asked.keys.map((k) => k.name);
    const body = reply ? { keys, values: reply.values } : { keys, skipped: true };
    (local
      ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/secrets`, body).then(() => null)
      : provideCloudSecrets(workspaceId, { ...body, save: reply?.save ?? false })
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
    (pending.some((p) => pendingShows(p, delivered)) ||
      (claudeIsWorking(conversation.events) && stoppedAt !== delivered));
  // Prompts sent while the agent is at work wait here (lib/session/prompt-queue.ts)
  // and go one at a time as each turn ends. One whose send failed holds the
  // queue (`queueHeld`) until the user retries it or sends it now, so a box
  // that's down doesn't fail the whole queue in a row.
  const [queue, setQueue] = useState<QueuedPrompt[]>(() => readQueue(tabStorage(), workspaceId));
  useEffect(() => writeQueue(tabStorage(), workspaceId, queue), [workspaceId, queue]);
  const [queueHeld, setQueueHeld] = useState(false);
  const sendingQueued = useRef(false);
  // Bumped as each queued send settles, so the queue looks again: the turn it
  // started may have ended while the send was still being answered.
  const [queueSettled, setQueueSettled] = useState(0);
  // The prompts the stream had recorded when the last queued prompt was sent:
  // the next waits until the stream records that one too. A prompt of files
  // alone has no bubble to say the session took it, so `working` alone could
  // let the next go into the same turn.
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const enqueue = (text: string, attachmentIds: string[]): Promise<boolean> => {
    setQueue((q) => [...q, { id: crypto.randomUUID(), text, attachmentIds }]);
    setSendError(null);
    return Promise.resolve(true);
  };
  /** Send a queued prompt now: out of the queue, and back at its head, the
   *  queue held, if it doesn't go (its Retry sends it again). */
  const sendQueued = (prompt: QueuedPrompt): Promise<boolean> => {
    setQueue((q) => q.filter((p) => p.id !== prompt.id));
    setQueueHeld(false);
    const recorded = userPromptCount(eventsRef.current);
    return send(prompt.text, prompt.attachmentIds, () => void sendQueued(prompt)).then((landed) => {
      if (landed) setQueuedAt(recorded);
      else {
        setQueue((q) => [prompt, ...q.filter((p) => p.id !== prompt.id)]);
        setQueueHeld(true);
      }
      return landed;
    });
  };
  const removeQueued = (prompt: QueuedPrompt) => {
    setQueue((q) => q.filter((p) => p.id !== prompt.id));
    // The one that failed sits at the head; with it gone, the rest go on.
    if (queue[0]?.id === prompt.id) setQueueHeld(false);
    // Its files were uploaded for it alone.
    for (const id of prompt.attachmentIds) void fetch(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => {});
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
    attached,
    working,
    waitingOnUser,
    held: queueHeld,
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
  // While the agent works, or others wait ahead, a prompt joins the queue.
  const sendOrQueue = (text: string, attachmentIds: string[]) =>
    working || queue.length > 0 ? enqueue(text, attachmentIds) : send(text, attachmentIds);

  const stop = () => {
    setStopping(true);
    setSendError(null);
    setStopError(null);
    (local
      ? localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/interrupt`)
      : stopCloudTurn(workspaceId)
    )
      .then(() => {
        setStoppedAt(userPromptCount(eventsRef.current));
        // A queued prompt Claude hadn't taken up yet is handed back to its
        // input by a stop, never recorded: the queue mustn't wait on it, nor
        // its bubble keep the page working.
        setQueuedAt(null);
        setPending(pendingAfterStop);
      })
      .catch((error: unknown) =>
        setStopError(
          local ? messageForLocalError(error) : error instanceof Error ? error.message : "Couldn't stop the turn.",
        ),
      )
      .finally(() => setStopping(false));
  };
  // The user's own accounts this session can switch to. A local session's
  // agent is already running on this Mac, so its own login there counts.
  const accounts = accountsHere(menu.agents, local, null);
  const modelChoice: ModelChoice = {
    groups: modelGroups(menu, accounts, agent),
    // The session's own agent's account, where it isn't connected here.
    connect: accounts.includes(agent) ? [] : [agent],
    effort,
    loadout: menu.loadout,
    preferredProvider: providerPicked ?? recorded?.model.provider ?? defaultModel(menu)?.provider,
    switching,
    disabledReason: !attached
      ? "Waiting for the session to connect"
      : waitingOnUser
        ? waitingOnSecrets
          ? `Answer ${AGENTS[agent].label}'s request first`
          : `Answer ${AGENTS[agent].label}'s question first`
        : working
          ? `Switch models once ${AGENTS[agent].label} has finished this turn`
          : null,
    onChange: (model, pickedEffort) => {
      // What the agent is told: an effort goes only with a model that takes one.
      const next = takesEffort(model) ? pickedEffort : null;
      setSwitching(true);
      setSendError(null);
      setSwitchError(null);
      // A local switch relaunches the session on this Mac: signed in as the
      // user picks now first, as the server does for a cloud one.
      (local
        ? deliverLocalAgentAuth(workspaceId, agent, runsOnOwnAccount(model)).then(() => putOnModel(workspaceId, model, next))
        : switchCloudModel(workspaceId, model, next))
        .then(() => {
          setPicked({ model: model.id, events: conversation.events.length });
          setProviderPicked(model.provider);
          rememberPickedProvider(workspaceId, model.provider);
          setEffortHere(next);
          rememberEffort(workspaceId, next);
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
  const settleCutOff = () => forgetFirstPromptOn(cutOffPath.current);
  const cutOffLanded = cutOff !== null && conversation.status === "connected" && userPromptCount(conversation.events) > 0;
  useEffect(() => {
    if (cutOffLanded) settleCutOff();
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
        if (landed) itWent();
        else if (!local) markFirstPromptGoing(tabStorage(), workspaceId, false);
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
    // send is stable enough; guard prevents a repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, initialPrompt, initialPromptKey, initialAttachmentIds]);

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

      <section className="studio-convo-panel" aria-label="Claude conversation">
        <div className="studio-convo-body">
          {/* Images Claude shows by path are on a cloud session's box; this
              Mac's are out of the server's reach. */}
          <ImageBoxContext value={local ? null : workspaceId}>
            <ConversationTimeline
              events={timelineEvents}
              working={working}
              placeholder={conversationPlaceholder({
                events: timelineEvents,
                attachment: attachment.status,
                stream: conversation.status,
              })}
            />
          </ImageBoxContext>
        </div>
      </section>

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
          onProvide={(values, save) => provideSecrets(secretRequest, { values, save })}
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
      {!waitingOnUser && questionGone ? (
        <InlineMessage tone="info" actions={[{ label: "Dismiss", onClick: () => setQuestionGone(null) }]}>
          {questionGone}
        </InlineMessage>
      ) : null}
      {!waitingOnUser && (
        <QueuedPrompts
          queue={queue}
          canSendNow={attached}
          onSendNow={(prompt) => void sendQueued(prompt)}
          onRemove={removeQueued}
        />
      )}
      {!waitingOnUser && (
        <SessionComposer
          onSend={sendOrQueue}
          placeholder={working ? "Queue a message for when this turn ends…" : undefined}
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
          sendErrorNoRetry={sendIsDeadEnd(sendError?.code)}
          newSessionHref={projectId ? `/new?project=${projectId}` : "/new"}
          onDismissSendError={() => setSendError(null)}
          onRetrySendError={sendError?.retry}
          stop={attached && working ? { onStop: stop, stopping } : undefined}
        />
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
async function switchCloudModel(workspaceId: string, model: SessionModel, effort: Effort | null): Promise<void> {
  const res = await reachOutrunner(`/api/workspaces/${workspaceId}/model`, {
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
async function answerCloudQuestion(workspaceId: string, body: unknown): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/answer`, {
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
async function provideCloudSecrets(workspaceId: string, body: unknown): Promise<string | null> {
  const res = await reachOutrunner(`/api/workspaces/${workspaceId}/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; saveError?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't send them. Please try again.");
  return data.saveError ?? null;
}

/** Stop a cloud session's turn. The server reaches the session's agent, as
 *  for a prompt. */
async function stopCloudTurn(workspaceId: string): Promise<void> {
  const res = await reachOutrunner(`/api/workspaces/${workspaceId}/interrupt`, { method: "POST" });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? "Couldn't stop the turn. Please try again.");
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
