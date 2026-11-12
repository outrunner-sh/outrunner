"use client";

import { ArrowUp, Check, Circle, Hammer, ImagePlus, ListChecks, MessageSquareText, Plus, Search, Settings2, Square, Video, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerAttachment } from "@/components/attachment-thumbnails";
import { Spinner } from "@/components/ui/loaders";
import { InlineMessage } from "@/components/ui/notice";
import { type PendingAttachment, useAttachments } from "@/hooks/use-attachments";
import { useNow } from "@/hooks/use-now";
import { useScreenRecorder } from "@/hooks/use-screen-recorder";
import { DRAFTS, draftPaintScript, PAGE_ONLY, useDraft, useHydrating } from "@/lib/client/drafts";
import { attachNotice, isImage, MAX_ATTACHMENTS_PER_MESSAGE, restoreDraft } from "@/lib/runtime/attachments";
import {
  RECORDING_LIMIT_MS,
  RECORDING_WARN_AT_MS,
  recordingClock,
  recordingFiles,
  stoppedNotice,
} from "@/lib/session/screen-recording";
import { AgentIcon, ProviderIcon } from "@/components/brand-icons";
import { CustomModelDialog } from "@/components/custom-model-dialog";
import {
  rememberCustomModel,
  rememberedCustomModels,
  takesTypedModels,
  typedModelOwner,
  type TypedModelProvider,
} from "@/lib/runtime/custom-models";
import { EffortMeter, effortName } from "@/components/effort-meter";
import {
  connectOffers,
  effortOnPick,
  loadoutModels,
  type ModelLoadout,
  searchModels,
} from "@/lib/runtime/model-loadout";
import {
  costHint,
  type Effort,
  EFFORT_LABELS,
  effortsFor,
  imageModelFor,
  matchModel,
  modelLabel,
  type ModelGroup,
  type ModelProvider,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";
import { isImeKeydown } from "@/lib/session/composing";
import { type DiffComment, lineRange } from "@/lib/session/diff-comments";
import { compactTokens, type ContextUsage } from "@/lib/runtime/context-usage";
import { composerCommand, otherMode, type SessionMode } from "@/lib/session/session-mode";
import { HistorySearch, MentionMenu } from "@/components/composer-menus";
import { usePromptHistory } from "@/hooks/use-prompt-history";
import type { FilesResponse } from "@/lib/runtime/agent-protocol";
import { insertMention, matchFiles, mentionAt, type MentionQuery, mentionSegments } from "@/lib/session/file-mentions";
import { type Recall, recallStep } from "@/lib/session/prompt-history";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
import { previewOf } from "@/lib/session/attachment-previews";
import { providerSettingsHref } from "@/lib/settings-links";
import { cn } from "@/lib/utils";

/**
 * The prompt composer pinned at the bottom of the conversation column. Sending
 * writes the text (plus a carriage return) into the live PTY, which is how a
 * prompt reaches Claude Code. Disabled unless this viewer holds the keyboard.
 *
 * Files can ride along: picked, dropped, or pasted. They upload immediately
 * rather than on send, so the wait happens while the user is still typing, and
 * `onSend` receives their ids to attach server-side.
 *
 * What is typed and attached is a draft kept at `draftKey`
 * (lib/client/drafts.ts): it is there again when the composer comes back, from
 * another page, the browser's Back or a reload, until it is sent.
 */

/** Switching the session's model, and the effort it runs at, from the footer,
 *  where the session allows it. */
export type ModelChoice = {
  groups: ModelGroup[];
  /** Exact optimistic/recorded selection, including custom IDs and capabilities. */
  selectedModel?: SessionModel;
  agent?: AgentId;
  harnessChoice?: {
    available: AgentId[];
    onChange?: (agent: AgentId) => void;
    disabledReason?: string;
    /** Existing chats continue through the runtime's fork lifecycle. */
    fork?: boolean;
  };
  /** `effort` null runs the model at its own. */
  onChange: (model: SessionModel, effort: Effort | null) => void;
  /** The effort the session runs at; null for the model's own. */
  effort: Effort | null;
  /** Why it can't switch right now (mid-turn, not at the keyboard); null when
   *  it can. */
  disabledReason: string | null;
  switching: boolean;
  /** Whose entry is the current one, for a model offered by two. */
  preferredProvider?: ModelProvider;
  /** The user's loadout (Settings → Default models): shown first, in place of
   *  the groups, where it has a model the menu offers. */
  loadout?: ModelLoadout;
  /** Agents whose own accounts aren't connected here, so their models aren't
   *  in `groups`: each offered as a link to connect it instead. */
  connect: AgentId[];
};

/** The session's mode (lib/session/session-mode.ts), switched from the
 *  footer's toggle or Shift+Tab. */
export type ModeChoice = {
  mode: SessionMode;
  onChange: (mode: SessionMode) => void;
};

export function SessionComposer({
  onSend,
  modeChoice,
  onCompact,
  onSideChat,
  context = null,
  canSend,
  sendDisabledReason,
  placeholder = "Ask anything, @ for context…",
  disabledPlaceholder = "Read-only — another viewer has the keyboard",
  model,
  modelChoice,
  allowAttachments = true,
  sendError = null,
  sendErrorNoRetry = false,
  newSessionHref,
  onDismissSendError,
  onRetrySendError,
  stop,
  focusSignal = 0,
  prefill = null,
  prefillAttachments = null,
  onPrefillAttachmentsTaken,
  draftKey,
  editing = null,
  comments,
  listFiles,
  onIntent,
  className,
}: {
  /** Send a prompt, in `mode` where the session has modes. When it returns
   *  a promise of whether the send landed, a failed send gives the text and
   *  files back to the composer. */
  onSend: (text: string, attachmentIds: string[], mode?: SessionMode) => void | Promise<boolean>;
  /** Plan and build: the toggle, Shift+Tab and /plan. Without it there are
   *  none, and /plan goes to the agent as typed. */
  modeChoice?: ModeChoice;
  /** /compact [instructions]: compact the conversation rather than send it.
   *  Without it, /compact goes to the agent as typed. Resolves whether it
   *  went, as onSend does. */
  onCompact?: (instructions: string) => Promise<boolean>;
  /** `/btw <question>`: ask it in a side chat about this one, whose turn
   *  goes on; resolves whether it went. Absent, `/btw` goes to the agent. */
  onSideChat?: (question: string) => Promise<boolean>;
  /** How full the session's context is, for the footer's ring; null hides it. */
  context?: ContextUsage | null;
  canSend: boolean;
  /** Keep typing and uploads available while selection capabilities load. */
  sendDisabledReason?: string;
  /** Placeholder shown while the user can type. */
  placeholder?: string;
  /** Placeholder shown when input is disabled (offline, reader, connecting…). */
  disabledPlaceholder?: string;
  /** The Claude model in use, shown in the footer. Omitted before any assistant
   *  turn has arrived (and on the new-session form, which has no session yet). */
  model?: string;
  /** Offers the models to switch to; without it the model is a plain label. */
  modelChoice?: ModelChoice;
  /** False hides attaching. Attachments are delivered by the server, which
   *  cannot reach a local session's worktree on the user's Mac. */
  allowAttachments?: boolean;
  /** Why the last send didn't go. A send from the box has its text back
   *  there, so the line offers to send it again or edit it first; one that
   *  didn't come from the box (onRetrySendError) offers Retry alone. */
  sendError?: string | null;
  /** The failure can't be fixed by trying again (the session's box is gone):
   *  the line offers no Retry, only the way forward. */
  sendErrorNoRetry?: boolean;
  /** Where "Continue in a new session" goes, for a send with no retry. */
  newSessionHref?: string;
  onDismissSendError?: () => void;
  /** Retry a send that didn't come from the box: a session's first prompt
   *  fails while the box is still empty, so its Retry sends the original
   *  again through here. Without this, Retry sends the box, which a failed
   *  send has put its text back into. */
  onRetrySendError?: () => void;
  /** Stopping the turn under way, shown beside send (and on Escape) while
   *  there is one to stop. */
  stop?: { onStop: () => void; stopping: boolean };
  /** Changes each time the composer should take focus (Get started's "Start
   *  your first session"); it does once it can be typed in. */
  focusSignal?: number;
  /** Text to start the box with once it arrives (a triage item's prompt on
   *  the new-session form), editable before it is sent. Never replaces what
   *  has been typed. */
  prefill?: string | null;
  /** Files to put back on the box, by attachment id: a send the server
   *  refused after the form had moved on (a new session's create), whose
   *  files were already taken off. Shown from this page's kept previews. */
  prefillAttachments?: readonly string[] | null;
  /** The files given back are on the box now: from here they are the box's,
   *  removed from it like any other, so they aren't given back again. */
  onPrefillAttachmentsTaken?: () => void;
  /** Where the draft is kept (lib/client/drafts.ts): `new` for the
   *  new-session form, `ws:<id>` for a session. Without it, the draft lasts as
   *  long as the page. */
  draftKey?: string;
  /** A sent message being edited (its pencil in the timeline): its text is
   *  put in the box, what was typed there kept for Cancel, which `onCancel`
   *  is told of. The next send replaces it (the caller rewinds first). */
  editing?: { key: string; text: string; onCancel: () => void } | null;
  /** Comments on the session's diff, waiting to go with the next message:
   *  shown above the box, each removable. The caller adds them to what is
   *  sent (onSend gets the typed text alone). */
  comments?: { items: DiffComment[]; onRemove: (id: string) => void };
  /** The session's files, for @ mentions (lib/session/file-mentions.ts):
   *  asked for once, as the first @ is typed. Without it @ is just text. */
  listFiles?: () => Promise<FilesResponse>;
  /** The user focused or typed in a composer whose destination can prepare
   *  work ahead of Send. Best effort and safe to call repeatedly. */
  onIntent?: () => void;
  /** A surrounding screen's layout and sizing, such as the home composer. */
  className?: string;
}) {
  const ownKey = `${PAGE_ONLY}composer:${useId()}`;
  // Editing gets a page-only draft of its own. The ordinary draft (text and
  // files) stays intact for Cancel and navigation; a reload must not turn
  // an unfinished edit into a new prompt.
  const [editSeen, setEditSeen] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState(0);
  if ((editing?.key ?? null) !== editSeen) {
    setEditSeen(editing?.key ?? null);
    if (editing) setEditVersion((version) => version + 1);
  }
  const key = editing ? `${ownKey}:edit:${editVersion}` : draftKey ?? ownKey;
  const draft = useDraft(key);
  const value = draft?.text ?? editing?.text ?? prefill ?? "";
  const setValue = (next: string | ((current: string) => string)) => DRAFTS.setText(key, next);
  const hydrating = useHydrating();
  const [sending, setSending] = useState(false);
  // Files dragged over the page: anywhere on it is the drop zone
  // (usePageDrop), and an overlay says so.
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(key);
  // A recording of the screen: the video and a few of its frames (the agent
  // can't watch a video, but sees images). Staged in the draft even while
  // the session isn't connected, or the composer is gone (a question card
  // in its place): uploading needs no session, and the recording can't be
  // made again.
  const recorder = useScreenRecorder({
    onRecorded: ({ video, frames, stoppedBy, durationMs }) => {
      const room = MAX_ATTACHMENTS_PER_MESSAGE - (DRAFTS.get(key)?.attachments.length ?? 0);
      const { files: recorded, notice: short } = recordingFiles(video, frames, room);
      attachments.add(recorded);
      const said = [stoppedNotice(stoppedBy, durationMs), short].filter(Boolean).join(" ");
      if (said) setNotice(said);
    },
    onNotice: setNotice,
  });
  // Recall (↑/↓ in an empty box, Ctrl+R to search) of the user's prompts.
  const { history, remember } = usePromptHistory(canSend);
  const [recall, setRecall] = useState<Recall | null>(null);
  const [searching, setSearching] = useState(false);
  // The @ mention being typed, the session's files to offer it, and which of
  // the matches is picked.
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [files, setFiles] = useState<FilesResponse | "loading" | "error" | null>(null);
  const [mentioned, setMentioned] = useState<ReadonlySet<string>>(() => new Set());
  const backdropRef = useRef<HTMLDivElement>(null);
  const fileList = files && typeof files === "object" ? files : null;
  // Over up to MaxListedFiles paths: worked out again only as the files or
  // the query change, not at every render (each keystroke, each caret move).
  const mentionQuery = mention?.query ?? null;
  const mentionMatches = useMemo(
    () => (mentionQuery !== null && fileList ? matchFiles(fileList.files, fileList.changed, mentionQuery) : []),
    [fileList, mentionQuery],
  );
  const changedFiles = useMemo(() => new Set(fileList?.files.slice(0, fileList.changed) ?? []), [fileList]);
  const mentionOpen = mention !== null && listFiles !== undefined;

  // The box is as tall as its text, however it got there (typed, prefilled,
  // a kept draft back, recalled, sent), before it paints.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Put back once per set given, as the text is, ahead of anything staged since.
  const restoredFor = useRef<string | null>(null);
  const restoreKey = prefillAttachments?.join(",") ?? "";
  const restoreAttachments = attachments.restore;
  useEffect(() => {
    if (!restoreKey || restoreKey === restoredFor.current) return;
    restoredFor.current = restoreKey;
    restoreAttachments(restoreKey.split(",").map(restoredAttachment));
    onPrefillAttachmentsTaken?.();
  }, [restoreKey, restoreAttachments, onPrefillAttachmentsTaken]);

  const focusedFor = useRef(0);
  useEffect(() => {
    if (focusSignal === 0 || focusSignal === focusedFor.current || !canSend) return;
    focusedFor.current = focusSignal;
    textareaRef.current?.focus();
  }, [focusSignal, canSend]);

  // A notice says something once, then gets out of the way.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // Named for the agent whose own model it is (Claude Code's, Codex's); one
  // on a key, or not known, is just "Message".
  const shownModel = modelChoice?.selectedModel ?? (modelChoice ? matchModel(modelChoice.groups, model, modelChoice.preferredProvider) : undefined);
  const provider = shownModel?.provider;
  const messageLabel = provider === "claude" || provider === "codex" ? `Message ${AGENTS[provider].label}` : "Message";

  // Files staged where they can't go (a draft's, carried into a form for this
  // Mac) stay in the draft for a cloud session, and aren't sent or waited on.
  const readyIds = allowAttachments ? attachments.readyIds : [];
  const uploading = allowAttachments && attachments.busy;
  // Images staged for a model that can't see them would fail the turn (the
  // provider refuses the request): said before sending, with a model that
  // can a click away, and the send held until one or the other.
  const blindModel =
    allowAttachments && shownModel?.supportsImages === false && attachments.items.some((item) => isImage(item.contentType))
      ? shownModel
      : null;
  const seeingModel = blindModel && modelChoice ? imageModelFor(modelChoice.groups, blindModel) : null;

  // A prompt of only attachments is legitimate — "here's a screenshot" — and
  // so is one of only comments on the diff.
  const hasSomethingToSend = value.trim() !== "" || readyIds.length > 0 || (comments?.items.length ?? 0) > 0;
  // Why Send is off beyond the usual: a recording in progress (a message
  // sent now would go without it), or the caller's reason.
  const sendBlocked = recorder.recording ? "Stop the recording to send it with your message" : sendDisabledReason;

  /** Stage files, or say why they cannot be (attachNotice). */
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    if (modelChoice?.switching) { setNotice("Wait for the selection change to finish before attaching files."); return; }
    const blocked = attachNotice({ allowed: allowAttachments, canSend, skipped: 0 });
    if (blocked) {
      setNotice(blocked);
      return;
    }
    setNotice(attachNotice({ allowed: true, canSend: true, skipped: attachments.add(files) }));
  }

  usePageDrop(allowAttachments, setDragging, addFiles, textareaRef);

  function submit() {
    // A message sent mid-recording would go without it.
    if (recorder.recording) {
      setNotice("Stop the recording to send it with your message.");
      return;
    }
    if (!canSend || sendDisabledReason || sending || !hasSomethingToSend || uploading || blindModel) return;
    let text = value.trim();
    let mode = modeChoice?.mode;
    const command = composerCommand(text);
    if (command?.kind === "compact" && onCompact) {
      // The box empties at once; the kept draft only once it went.
      const release = DRAFTS.hold(key, text);
      setValue("");
      setSending(true);
      void onCompact(command.instructions)
        .then((went) => {
          if (!went) setValue((current) => restoreDraft(text, current));
        })
        .finally(() => {
          release();
          setSending(false);
        });
      return;
    }
    if (command?.kind === "side" && onSideChat) {
      // Asked beside the chat, not in it: its turn goes on.
      if (!command.question) return;
      setValue("");
      setSending(true);
      void onSideChat(command.question)
        .then((went) => {
          if (!went) setValue((current) => restoreDraft(text, current));
        })
        .finally(() => setSending(false));
      return;
    }
    if (command?.kind === "plan" && modeChoice) {
      // One prompt in plan mode, and the toggle with it: the session is
      // planning now. /plan alone just switches.
      if (modeChoice.mode !== "plan") modeChoice.onChange("plan");
      mode = "plan";
      if (!command.prompt && readyIds.length === 0) {
        setValue("");
        return;
      }
      text = command.prompt;
    }
    // What this send carries, kept apart from whatever is typed or attached
    // while it is in flight. The box empties at once, files and all: the
    // message shows them now. A failed send gives its text and files back,
    // ahead of anything typed or attached since, so nothing is lost.
    const sentIds = readyIds;
    const taken = attachments.forget(sentIds);
    const result = onSend(text, sentIds, mode);
    // The box empties at once; the kept draft only once the send lands, so a
    // reload while it is on its way gives the prompt and its files back.
    const release = DRAFTS.hold(key, text, taken);
    setValue("");
    setRecall(null);
    closeMention();
    if (!result) {
      release();
      remember(text);
      return;
    }
    setSending(true);
    void result
      .then((landed) => {
        if (landed) {
          // Recalled once it went: one that didn't is back in the box.
          remember(text);
        } else {
          setValue((current) => restoreDraft(text, current));
          attachments.restore(taken);
          textareaRef.current?.focus();
        }
      })
      .finally(() => {
        release();
        setSending(false);
      });
  }

  /** Close the @ menu. A listing that failed is let go, so the next @ typed
   *  asks again: a runner restarting, or a blip, isn't the menu's answer for
   *  the rest of the session. */
  function closeMention() {
    setMention(null);
    setFiles((f) => (f === "error" ? null : f));
  }

  /** Put `next` in the box (recall's), the caret at its end. */
  function replaceText(next: string) {
    setValue(next);
    closeMention();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.setSelectionRange(next.length, next.length);
    });
  }

  /** Follow the caret: an @ mention being typed opens its menu, the files
   *  asked for the first time one is. */
  function followCaret(text: string, caret: number) {
    const at = listFiles ? mentionAt(text, caret) : null;
    setMention(at);
    setMentionIndex(0);
    if (at && files === null && listFiles) {
      setFiles("loading");
      listFiles().then(setFiles, () => setFiles("error"));
    }
  }

  function pickMention(path: string) {
    const el = textareaRef.current;
    if (!mention || !el) return;
    const next = insertMention(value, mention, el.selectionStart, path);
    setValue(next.text);
    setMentioned((prev) => new Set(prev).add(path));
    closeMention();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  // Mentions drawn as pills: those picked here, and any typed in full.
  const known = useMemo(() => new Set([...mentioned, ...(fileList?.files ?? [])]), [mentioned, fileList]);
  const segments = value.includes("@") ? mentionSegments(value, known) : [];
  const pills = segments.some((segment) => segment.mention);

  return (
    <form
      className={cn("studio-composer", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {dragging &&
        createPortal(
          <div className="page-drop-overlay" aria-hidden>
            <div>
              <ImagePlus />
              Drop to attach
            </div>
          </div>,
          document.body,
        )}
      {notice && (
        <p role="status" className="studio-composer-notice">
          {notice}
        </p>
      )}
      {editing && (
        <InlineMessage
          className="studio-composer-message"
          actions={[
            {
              label: "Cancel",
              onClick: () => {
                editing.onCancel();
              },
            },
          ]}
        >
          Editing a message · Sending replaces it and everything after it in this chat. Files and git changes are not
          rolled back, and attachments and diff comments aren&apos;t carried over.
        </InlineMessage>
      )}
      {sendError && !sending && (
        <InlineMessage
          className="studio-composer-message"
          actions={
            sendErrorNoRetry
              ? // Retrying fails the same way every time: offer the way on
                // instead of a Retry that can't work.
                [{ label: "Continue in a new session", primary: true, href: newSessionHref ?? "/new" }]
              : [
                  { label: "Retry", onClick: onRetrySendError ?? submit, disabled: !canSend },
                  // Edit is for text the failure put back in the box. A send that
                  // never came from it (a first prompt) has nothing there to edit.
                  ...(onRetrySendError
                    ? []
                    : [
                        {
                          label: "Edit",
                          onClick: () => {
                            onDismissSendError?.();
                            textareaRef.current?.focus();
                          },
                        },
                      ]),
                ]
          }
        >
          Not sent · {sendError}
        </InlineMessage>
      )}
      {comments && comments.items.length > 0 && (
        <ul className="studio-composer-comments" aria-label="Comments on the diff">
          {comments.items.map((c) => (
            <li key={c.id} title={c.comment}>
              <MessageSquareText aria-hidden />
              <span className="font-mono">
                {c.path}:{lineRange(c.startLine, c.endLine).replace("-", "–")}
              </span>
              <span className="studio-composer-comment-text">{c.comment}</span>
              <button type="button" onClick={() => comments.onRemove(c.id)} aria-label={`Remove comment on ${c.path}`}>
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.items.length > 0 && (
        <ul className="attachment-tiles" aria-label="Attachments">
          {attachments.items.map((item) => (
            <ComposerAttachment key={item.key} item={item} onRemove={() => attachments.remove(item.key)} />
          ))}
        </ul>
      )}
      {blindModel && (
        <InlineMessage
          tone="warning"
          className="studio-composer-message"
          actions={[
            ...(seeingModel && modelChoice
              ? [
                  {
                    label: `Switch to ${seeingModel.label}`,
                    primary: true,
                    disabled: modelChoice.switching || modelChoice.disabledReason !== null,
                    onClick: () => modelChoice.onChange(seeingModel, effortOnPick(modelChoice.loadout, seeingModel)),
                  },
                ]
              : []),
            {
              label: "Remove images",
              onClick: () => {
                for (const item of attachments.items) if (isImage(item.contentType)) attachments.remove(item.key);
              },
            },
          ]}
        >
          {blindModel.label} can&apos;t see images.{" "}
          {seeingModel ? `Switch to ${seeingModel.label} to send them.` : "Switch to a model that can to send them."}
          {modelChoice?.disabledReason && seeingModel ? ` (${modelChoice.disabledReason})` : ""}
        </InlineMessage>
      )}
      {!allowAttachments && attachments.items.length > 0 && (
        <InlineMessage className="studio-composer-message" tone="info">
          These files stay for a cloud session: a session on this Mac can&apos;t take them.
        </InlineMessage>
      )}
      {attachments.items
        .filter((item) => item.status === "error")
        .map((item) => (
          <InlineMessage
            key={item.key}
            className="studio-composer-message"
            actions={[{ label: "Remove", onClick: () => attachments.remove(item.key) }]}
          >
            {item.filename}: {item.error ?? "Couldn't attach this file."}
          </InlineMessage>
        ))}

      {searching && (
        <HistorySearch
          history={history}
          onPick={(prompt) => {
            setSearching(false);
            setRecall(null);
            textareaRef.current?.focus();
            replaceText(prompt);
          }}
          onClose={() => setSearching(false)}
        />
      )}
      {!searching && mentionOpen && (
        <MentionMenu
          matches={mentionMatches}
          active={Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1))}
          changed={changedFiles}
          status={files === "error" ? "error" : fileList ? "ready" : "loading"}
          onPick={pickMention}
          onHover={setMentionIndex}
        />
      )}
      <div className="studio-composer-input">
        {pills && (
          <div ref={backdropRef} className="studio-composer-backdrop" aria-hidden>
            {segments.map((segment, i) => (segment.mention ? <mark key={i}>{segment.text}</mark> : segment.text))}
            {/* A trailing newline needs a character after it to take a line. */}
            {"\u200b"}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={canSend ? placeholder : disabledPlaceholder}
          aria-label={messageLabel}
          spellCheck={false}
          disabled={!canSend}
          onFocus={onIntent}
          onChange={(event) => {
            setValue(event.target.value);
            onIntent?.();
            // Typing over a recalled prompt makes it this one's.
            setRecall(null);
            followCaret(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => {
            const el = event.currentTarget;
            if (mention) followCaret(el.value, el.selectionStart);
          }}
          onBlur={closeMention}
          onScroll={(event) => {
            if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onPaste={(event) => {
            // Pasted screenshots arrive as files on the clipboard. Only intercept
            // when there are some, so ordinary text paste is untouched.
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (isImeKeydown(event.nativeEvent)) return;
            const el = event.currentTarget;
            // The @ menu, while it's open, has the keys that move in it and pick.
            if (mentionOpen) {
              if (event.key === "Escape") {
                event.preventDefault();
                closeMention();
                return;
              }
              if (mentionMatches.length > 0) {
                const count = mentionMatches.length;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((i) => (Math.min(i, count - 1) + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
                  return;
                }
                if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                  event.preventDefault();
                  pickMention(mentionMatches[Math.min(mentionIndex, count - 1)]);
                  return;
                }
              }
            }
            if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r") {
              // As a shell's reverse search: the browser's reload stays on ⌘R/F5.
              event.preventDefault();
              closeMention();
              setSearching(true);
              return;
            }
            if (event.key === "Tab" && event.shiftKey && modeChoice) {
              // As in Claude Code's own terminal: Shift+Tab switches the mode.
              event.preventDefault();
              modeChoice.onChange(otherMode(modeChoice.mode));
              return;
            }
            // ↑ in an empty box, or on the first line of a recalled prompt,
            // steps back through the user's prompts; ↓ on its last line, forward.
            const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
            const onFirstLine = !el.value.slice(0, el.selectionStart).includes("\n");
            const onLastLine = !el.value.slice(el.selectionEnd).includes("\n");
            if (plain && event.key === "ArrowUp" && (value === "" || (recall && onFirstLine))) {
              const step = recallStep(history, recall, "older", value);
              if (step) {
                event.preventDefault();
                setRecall(step.recall);
                replaceText(step.value);
              }
              return;
            }
            if (plain && event.key === "ArrowDown" && recall && onLastLine) {
              const step = recallStep(history, recall, "newer", value);
              if (step) {
                event.preventDefault();
                setRecall(step.recall);
                replaceText(step.value);
              }
              return;
            }
            // Not while an input method is composing (checked first): there,
            // Enter confirms the characters rather than sending half a prompt.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && stop && !stop.stopping) {
              event.preventDefault();
              stop.onStop();
            }
          }}
        />
        {/* A reload paints the kept draft in the box, not an empty one until
            the page hydrates. Only in the server's HTML: a script React adds
            itself never runs. */}
        {draftKey && hydrating && <script dangerouslySetInnerHTML={{ __html: draftPaintScript(draftKey) }} />}
      </div>
      <div className="studio-composer-footer">
        <span>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              // Reset so picking the same file twice still fires onChange.
              event.target.value = "";
            }}
          />
          {allowAttachments && (
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              disabled={!canSend}
              onClick={() => fileRef.current?.click()}
            >
              <Plus />
            </button>
          )}
          {allowAttachments &&
            recorder.supported &&
            (recorder.startedAt !== null ? (
              <RecordingStop startedAt={recorder.startedAt} onStop={() => void recorder.stop()} />
            ) : (
              <button
                type="button"
                aria-label="Record screen"
                title={
                  attachments.items.length >= MAX_ATTACHMENTS_PER_MESSAGE
                    ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`
                    : "Record your screen"
                }
                disabled={!canSend || recorder.starting || attachments.items.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                onClick={() => void recorder.start()}
              >
                <Video />
              </button>
            ))}
          {modeChoice && <ModeToggle choice={modeChoice} disabled={!canSend} />}
          {modelChoice ? (
            <ModelPicker model={model} choice={modelChoice} uploading={uploading} />
          ) : (
            model && <span className="studio-composer-model">{modelLabel(model)}</span>
          )}
        </span>
        <span>
          {context && <ContextRing usage={context} />}
          {stop && (
            <button
              type="button"
              className="studio-composer-stop"
              onClick={stop.onStop}
              disabled={stop.stopping}
              aria-label="Stop"
              title="Stop (Esc)"
            >
              {stop.stopping ? <Spinner /> : <Square />}
            </button>
          )}
          <button
            type="submit"
            className="studio-composer-send"
            disabled={!canSend || !!sendBlocked || sending || !hasSomethingToSend || uploading || blindModel !== null}
            aria-label="Send"
            title={sendBlocked ?? (blindModel ? `${blindModel.label} can't see images` : undefined)}
          >
            <ArrowUp />
          </button>
        </span>
      </div>
    </form>
  );
}

/** A screen recording in progress: how long so far, and Stop. */
function RecordingStop({ startedAt, onStop }: { startedAt: number; onStop: () => void }) {
  const elapsed = useNow(1000) - startedAt;
  // Near the limit, the time it stops at too, so the stop isn't a surprise.
  const ending = elapsed >= RECORDING_WARN_AT_MS;
  return (
    <button
      type="button"
      className={cn("studio-composer-recording", ending && "is-ending")}
      onClick={onStop}
      title={ending ? `Stops at ${recordingClock(RECORDING_LIMIT_MS)}` : "Stop recording"}
      aria-label="Stop recording"
    >
      <span className="studio-composer-recording-dot" aria-hidden />
      <span aria-hidden>
        {recordingClock(elapsed)}
        {ending && ` of ${recordingClock(RECORDING_LIMIT_MS)}`}
      </span>
      Stop
    </button>
  );
}

/** Build or Plan, the mode the next prompt goes in: a click (or Shift+Tab in
 *  the box) switches it. */
function ModeToggle({ choice, disabled }: { choice: ModeChoice; disabled: boolean }) {
  const planning = choice.mode === "plan";
  return (
    <button
      type="button"
      className={cn("studio-composer-mode", planning && "is-plan")}
      onClick={() => choice.onChange(otherMode(choice.mode))}
      disabled={disabled}
      aria-pressed={planning}
      aria-label={planning ? "Plan mode: plans before changing anything. Switch to build" : "Build mode. Switch to plan"}
      title={`${planning ? "Plan: reads and proposes a plan, changes nothing" : "Build: makes the changes"} (Shift+Tab to switch)`}
    >
      {planning ? <ListChecks /> : <Hammer />}
      {planning ? "Plan" : "Build"}
    </button>
  );
}

/** How full the session's context is: a ring, filling as its replies use the
 *  model's window, with the numbers beside it. */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const share = Math.min(1, usage.used / usage.window);
  const r = 6;
  const length = 2 * Math.PI * r;
  const percent = Math.round(share * 100);
  return (
    <span
      className={cn("studio-composer-context", share >= 0.8 && "is-full")}
      title={`Context: ${usage.used.toLocaleString("en-US")} of ${usage.window.toLocaleString("en-US")} tokens (${percent}%). /compact to summarize it.`}
      aria-label={`Context ${percent}% full`}
      role="img"
    >
      <svg viewBox="0 0 16 16" aria-hidden>
        <circle className="ring-track" cx="8" cy="8" r={r} fill="none" strokeWidth="2" />
        <circle
          className="ring-fill"
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${share * length} ${length}`}
        />
      </svg>
      {compactTokens(usage.used)} / {compactTokens(usage.window)}
    </span>
  );
}

/** A model's mark: its agent's for Claude Code's and Codex's own, its
 *  provider's for one on a key. */
function ModelIcon({ provider }: { provider: ModelProvider }) {
  if (provider === "claude" || provider === "codex") return <AgentIcon agent={provider} />;
  return <ProviderIcon provider={provider === "outrunner" ? "openrouter" : provider} />;
}

/** The footer's model, as a menu of the models the session can switch to:
 *  the user's loadout where they have one, else every group, and a search
 *  across all of them either way. */
function ModelPicker({ model, choice, uploading }: { model?: string; choice: ModelChoice; uploading: boolean }) {
  // A group on the user's own key offers the ids they typed in before, and
  // takes another (CustomModelDialog).
  const [customFor, setCustomFor] = useState<TypedModelProvider | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState<"main" | "harness" | "model" | "effort">("main");
  const groups = choice.groups.map((group) => {
    const own = group.custom && takesTypedModels(group.provider) ? group.provider : null;
    if (!own) return { ...group, own };
    const typed = rememberedCustomModels(own).filter((m) => !group.models.some((listed) => listed.id === m.id));
    return { ...group, own, models: [...group.models, ...typed] };
  });
  const current = choice.selectedModel ?? matchModel(groups, model, choice.preferredProvider);
  const name = current?.label ?? (model ? modelLabel(model) : "Model");
  // The effort shows only where it does something.
  const effort = current && takesEffort(current) ? choice.effort : undefined;
  const savedEffort = current?.provider === "codex" && effort === undefined ? choice.effort : null;
  const harness = choice.agent ? AGENTS[choice.agent].label : "Harness";
  const blocked = choice.disabledReason ?? (choice.switching ? "Switching model" : null);
  const label = choice.switching
    ? "Switching model"
    : effort === undefined
      ? savedEffort ? `${name}, ${effortName(savedEffort)} saved effort` : name
      : `${name}, ${effortName(effort)} effort`;
  const loadout = choice.loadout ? loadoutModels(choice.loadout, groups) : [];
  const searching = query.trim() !== "";
  // Searching looks through everything; otherwise the loadout, where there is
  // one, stands in for the groups.
  const flat = searching ? searchModels(groups.flatMap((g) => g.models), query) : loadout;
  const showGroups = !searching && (showAll || loadout.length === 0);
  const connect = connectOffers(choice.connect, query, flat.length);
  const isCurrent = (m: SessionModel) => m.id === current?.id && m.provider === current.provider;
  const item = (m: SessionModel) => (
    <DropdownMenuItem
      key={`${m.provider}:${m.id}`}
      role="menuitemradio"
      aria-checked={isCurrent(m)}
      // Always sent, even for the ticked family: the session may run an
      // older model of it, and the agent ignores a switch to what it has.
      // The same model keeps its effort; another runs at the loadout's for
      // it, else DEFAULT_EFFORT.
      disabled={!!blocked}
      onSelect={() => choice.onChange(m, isCurrent(m) ? choice.effort : effortOnPick(choice.loadout, m))}
    >
      <ModelIcon provider={m.provider} />
      {/* The current model in the brand's colour, as a tick would mark it. */}
      <span className={cn("flex-1 truncate", isCurrent(m) && "text-brand")}>{m.label}</span>
      <Check aria-hidden className={isCurrent(m) ? "opacity-100" : "opacity-0"} />
      <span className={cn("text-xs tabular-nums text-muted-foreground", isCurrent(m) && "text-brand")}>
        {costHint(m)}
      </span>
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (!open) { setQuery(""); setShowAll(false); setPage("main"); } }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="studio-composer-model studio-composer-model-picker"
            title={blocked ?? "Choose harness, model and effort"}
            aria-label={`Harness: ${harness}. Model: ${label}. Choose harness, model and effort`}
          >
            {/* Both labels share one cell, so the footer holds still while the
                name gives way to "Switching" and back. */}
            <span className="grid min-w-0 place-items-center">
              <span className={cn("col-start-1 row-start-1 inline-flex min-w-0 items-center gap-2", choice.switching && "invisible")}>
                <span className="min-w-0 max-w-48 truncate">{harness} · {name}</span>
                {(effort !== undefined || savedEffort) && <EffortMeter effort={effort ?? savedEffort} />}
              </span>
              <span
                aria-hidden
                className={cn("col-start-1 row-start-1 inline-flex items-center gap-1", !choice.switching && "invisible")}
              >
                <Spinner /> Switching
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-80 max-w-[calc(100vw-1rem)] border-(--studio-border)"
        >
          {blocked && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{blocked}</p>}
          {page === "main" ? <>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setPage("harness"); }}>
              <span className="flex-1">Harness</span><span>{harness}</span><span aria-hidden>›</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setPage("model"); }}>
              <span className="flex-1">Model</span><span className="max-w-48 truncate">{name}</span><span aria-hidden>›</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!current || effort === undefined} onSelect={(event) => { event.preventDefault(); setPage("effort"); }}>
              <span className="flex-1">Effort</span><span>{effort === undefined ? savedEffort ? `${effortName(savedEffort)} (saved)` : "Runtime default" : effortName(effort)}</span><span aria-hidden>›</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link href="/settings/models"><Settings2 />Change defaults</Link></DropdownMenuItem>
          </> : <>
          <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setQuery(""); setShowAll(false); setPage("main"); }}>‹ Back</DropdownMenuItem>
          <DropdownMenuLabel>{page === "harness" ? "Harness" : page === "effort" ? "Effort" : "Model"}</DropdownMenuLabel>
          {page === "harness" ? <>
            {(choice.harnessChoice?.available ?? (choice.agent ? [choice.agent] : [])).map((agent) => (
              <DropdownMenuItem key={agent} role="menuitemradio" aria-checked={agent === choice.agent} disabled={!!blocked || !choice.harnessChoice?.onChange || (choice.harnessChoice.fork && (uploading || agent === choice.agent))} onSelect={() => choice.harnessChoice?.onChange?.(agent)}>
                <AgentIcon agent={agent} /><span className="flex-1">{choice.harnessChoice?.fork && agent !== choice.agent ? `Fork with ${AGENTS[agent].label}` : AGENTS[agent].label}</span><Circle aria-hidden className={cn("size-2 fill-current", agent === choice.agent ? "opacity-100" : "opacity-0")} />
              </DropdownMenuItem>
            ))}
            {choice.harnessChoice?.fork && uploading && <p className="px-2 py-2 text-xs text-muted-foreground">Wait for attachments to finish uploading before forking.</p>}
            {choice.harnessChoice?.disabledReason && <p className="px-2 py-2 text-xs text-muted-foreground">{choice.harnessChoice.disabledReason}</p>}
            {!choice.harnessChoice?.onChange && <DropdownMenuItem asChild><Link href="/new">Choose a harness for a new session</Link></DropdownMenuItem>}
          </> : page === "effort" ? <>
            {current && [null, ...effortsFor(current)].map((level) => (
              <DropdownMenuItem key={level ?? "default"} role="menuitemradio" aria-checked={level === effort} disabled={!!blocked} onSelect={() => choice.onChange(current, level)}>
                <EffortMeter effort={level} /><span className="flex-1">{level ? EFFORT_LABELS[level] : effortName(null)}</span>
                <Check aria-hidden className={level === effort ? "opacity-100" : "opacity-0"} />
              </DropdownMenuItem>
            ))}
          </> : <>
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // The menu's own typeahead would take the letters typed here.
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Search models"
              aria-label="Search models"
              autoFocus
              spellCheck={false}
              className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <DropdownMenuItem asChild className="size-7 justify-center p-0 text-muted-foreground">
              <Link href="/settings/models" aria-label="Edit models" title="Edit models">
                <Settings2 />
              </Link>
            </DropdownMenuItem>
          </div>
          <DropdownMenuSeparator />
          {showGroups
            ? groups.map((group, i) => (
                <div key={group.label}>
                  {/* Groups set apart by their headings, not rules. */}
                  <DropdownMenuLabel className={cn("text-xs font-normal text-muted-foreground", i > 0 && "pt-3")}>
                    {group.label}
                  </DropdownMenuLabel>
                  {group.models.map(item)}
                  {group.own ? (
                    <DropdownMenuItem disabled={!!blocked} onSelect={() => setCustomFor(group.own)}>
                      <Check className="opacity-0" />
                      <span className="text-muted-foreground">Other model…</span>
                    </DropdownMenuItem>
                  ) : null}
                </div>
              ))
            : flat.map(item)}
          {!showGroups && !searching && <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setShowAll(true); }}>All models…</DropdownMenuItem>}
          {searching && flat.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No model matches “{query.trim()}”.</p>
          ) : null}
          {/* Without the groups, their way to type a model in stays here. */}
          {!showGroups && groups.some((group) => group.own) ? <DropdownMenuSeparator /> : null}
          {!showGroups
            ? groups.flatMap((group) =>
                group.own ? (
                  <DropdownMenuItem key={`other:${group.provider}`} disabled={!!blocked} onSelect={() => setCustomFor(group.own)}>
                    <ModelIcon provider={group.provider} />
                    <span className="text-muted-foreground">Other {typedModelOwner(group.own).label} model…</span>
                  </DropdownMenuItem>
                ) : [],
              )
            : null}
          {connect.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              {connect.map((agent) => (
                <DropdownMenuItem key={`connect:${agent}`} asChild>
                  <Link href={providerSettingsHref(agent)}>
                    <AgentIcon agent={agent} />
                    <span className="flex-1 truncate">Connect {AGENTS[agent].label}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          </>}
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomModelDialog
        provider={customFor}
        onOpenChange={(open) => {
          if (!open) setCustomFor(null);
        }}
        onChoose={(provider, id) => {
          rememberCustomModel(provider, id);
          choice.onChange({ id, label: id, provider }, null);
        }}
      />
    </>
  );
}

/** The composers that take files dropped or pasted on the page, the newest
 *  last: only it does, so a page with two takes each file once. */
const dropTargets: symbol[] = [];

/**
 * The whole page as the composer's drop zone: files dragged anywhere on it
 * light an overlay (`setDragging`) and land in the composer (`addFiles`)
 * when dropped. A drop is always caught, even where nothing can take it:
 * left to the browser, it opens the file in a tab, away from the session.
 * Files pasted with the focus outside any field (on the conversation, say)
 * are taken too; the box's own paste is its onPaste's.
 */
function usePageDrop(
  enabled: boolean,
  setDragging: (dragging: boolean) => void,
  addFiles: (files: File[]) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  // The latest, for listeners added once.
  const add = useRef(addFiles);
  useEffect(() => {
    add.current = addFiles;
  });
  useEffect(() => {
    if (!enabled) return;
    const me = Symbol("composer");
    dropTargets.push(me);
    const mine = () => dropTargets[dropTargets.length - 1] === me;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    // dragenter/dragleave fire for every element the pointer crosses: the
    // overlay follows the count, so it doesn't flicker on the way across.
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event) || !mine()) return;
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer && mine()) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event) || !mine()) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (mine()) add.current(Array.from(event.dataTransfer?.files ?? []));
    };
    const paste = (event: ClipboardEvent) => {
      if (!mine() || event.target === textareaRef.current) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      add.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
      dropTargets.splice(dropTargets.indexOf(me), 1);
      setDragging(false);
    };
  }, [enabled, setDragging, textareaRef]);
}

/** A sent file put back on the box: uploaded already, shown from what this
 *  page kept of it (lib/session/attachment-previews.ts). */
function restoredAttachment(id: string): PendingAttachment {
  const preview = previewOf(id);
  return {
    key: `restored-${id}`,
    id,
    filename: preview?.filename ?? "Attachment",
    contentType: preview?.contentType ?? "",
    sizeBytes: 0,
    previewUrl: preview?.url ?? null,
    status: "ready",
  };
}
