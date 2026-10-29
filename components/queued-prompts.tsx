"use client";

import { ArrowDown, ArrowUp, CornerDownRight, ListChecks, MessageSquareText, Paperclip, Pencil, Send, X } from "lucide-react";

import { attachmentFiles } from "@/components/attachment-thumbnails";
import { parseCommentQuotes } from "@/lib/session/diff-comments";
import type { QueuedPrompt } from "@/lib/session/prompt-queue";

/**
 * The prompts waiting for the agent's turn to end, oldest first, just above
 * the composer: each goes on its own when its turn comes, or sooner, steered
 * into the running turn (the agent takes it at its next step) or sent now
 * (the turn stopped first), or not at all (Remove). While one waits it can be
 * edited, and moved up or down.
 */
export function QueuedPrompts({
  queue,
  working,
  onSteer,
  onSendNow,
  onRemove,
  onEdit,
  onMove,
  canSendNow,
  paused = false,
  editing,
  onEditingChange,
}: {
  queue: QueuedPrompt[];
  editing: { id: string; words: string } | null;
  onEditingChange: (editing: { id: string; words: string } | null) => void;
  /** The agent is at its turn: a prompt can be steered into it, or sent in
   *  place of the rest of it. Between turns (a stop held the queue) there is
   *  nothing to steer, and sending now is just sending. */
  working: boolean;
  onSteer: (prompt: QueuedPrompt) => void;
  onSendNow: (prompt: QueuedPrompt) => void;
  onRemove: (prompt: QueuedPrompt) => void;
  /** New words for a prompt; the comments on the diff it carries stay. */
  onEdit: (prompt: QueuedPrompt, words: string) => void;
  /** Move a prompt one place sooner (-1) or later (1). */
  onMove: (prompt: QueuedPrompt, by: -1 | 1) => void;
  /** False while the session can't take a prompt (not connected). */
  canSendNow: boolean;
  /** Held since the user stopped the turn: the next prompt sent lets them
   *  go, ahead of it. */
  paused?: boolean;
}) {
  // The prompt whose words are being edited, and the words so far.
  if (queue.length === 0) return null;
  const save = (prompt: QueuedPrompt) => {
    if (editing && editing.id === prompt.id) onEdit(prompt, editing.words);
    onEditingChange(null);
  };
  return (
    <section className="studio-queue" aria-label="Queued messages">
      <p className="studio-queue-label">
        {paused ? "Queued · held since you stopped the turn; your next message goes after them" : "Queued · sends when the current turn ends"}
      </p>
      <ol>
        {queue.map((prompt, index) => {
          // Comments on the diff it carries are counted, not spelled out.
          const { text, quotes } = parseCommentQuotes(prompt.text);
          const isEditing = editing?.id === prompt.id;
          return (
            <li key={prompt.id} className="studio-queue-item">
              {prompt.mode === "plan" && (
                <span className="studio-queue-files" title="Goes in plan mode">
                  <ListChecks aria-hidden />
                  Plan
                </span>
              )}
              {isEditing ? (
                <textarea
                  className="studio-queue-edit"
                  autoFocus
                  rows={Math.min(6, Math.max(1, editing.words.split("\n").length))}
                  value={editing.words}
                  aria-label="Edit queued message"
                  onChange={(event) => onEditingChange({ id: prompt.id, words: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      save(prompt);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      onEditingChange(null);
                    }
                  }}
                  onBlur={() => save(prompt)}
                />
              ) : (
                <span className="studio-queue-text" title={text}>
                  {text || (quotes.length > 0 ? "Comments only" : "Files only")}
                </span>
              )}
              {quotes.length > 0 && (
                <span className="studio-queue-files" title={`${quotes.length} comment${quotes.length === 1 ? "" : "s"} on the diff`}>
                  <MessageSquareText aria-hidden />
                  {quotes.length}
                </span>
              )}
              {prompt.attachmentIds.length > 0 && <QueuedFiles ids={prompt.attachmentIds} />}
              {!isEditing && (
                <span className="studio-queue-actions">
                  <button
                    type="button"
                    onClick={() => onMove(prompt, -1)}
                    disabled={index === 0}
                    title="Move up: sends sooner"
                    aria-label="Move up"
                  >
                    <ArrowUp aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(prompt, 1)}
                    disabled={index === queue.length - 1}
                    title="Move down: sends later"
                    aria-label="Move down"
                  >
                    <ArrowDown aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEditingChange({ id: prompt.id, words: text })}
                    title="Edit before it sends"
                    aria-label="Edit"
                  >
                    <Pencil aria-hidden />
                  </button>
                  {working && (
                    <button
                      type="button"
                      onClick={() => onSteer(prompt)}
                      disabled={!canSendNow}
                      title="Steer: into the running turn, without stopping it; the agent takes it at its next step"
                      aria-label="Steer"
                    >
                      <CornerDownRight aria-hidden />
                      Steer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSendNow(prompt)}
                    disabled={!canSendNow}
                    title={working ? "Send now: stops the running turn, then sends this; the rest of the queue goes after it" : "Send now"}
                    aria-label="Send now"
                  >
                    <Send aria-hidden />
                    Send now
                  </button>
                  <button type="button" onClick={() => onRemove(prompt)} title="Remove from the queue" aria-label="Remove">
                    <X aria-hidden />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A queued prompt's files: its images as small thumbnails from this page's
 *  copies, the rest counted. */
function QueuedFiles({ ids }: { ids: string[] }) {
  const files = attachmentFiles(ids);
  const images = files.filter((file) => file.image && file.src).slice(0, 3);
  const others = files.length - images.length;
  return (
    <span className="studio-queue-files" title={`${files.length} attached`}>
      {images.map((file) => (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL
        <img key={file.key} src={file.src!} alt={file.name} className="studio-queue-thumb" />
      ))}
      {others > 0 && (
        <>
          <Paperclip aria-hidden />
          {others}
        </>
      )}
    </span>
  );
}
