"use client";

import { ArrowUp, ListChecks, MessageSquareText, Paperclip, X } from "lucide-react";

import { parseCommentQuotes } from "@/lib/session/diff-comments";
import type { QueuedPrompt } from "@/lib/session/prompt-queue";

/**
 * The prompts waiting for the agent's turn to end, oldest first, just above
 * the composer: each goes on its own when its turn comes, or now (Send now:
 * the agent takes it at its next step), or not at all (Remove).
 */
export function QueuedPrompts({
  queue,
  onSendNow,
  onRemove,
  canSendNow,
  paused = false,
}: {
  queue: QueuedPrompt[];
  onSendNow: (prompt: QueuedPrompt) => void;
  onRemove: (prompt: QueuedPrompt) => void;
  /** False while the session can't take a prompt (not connected). */
  canSendNow: boolean;
  /** Held since the user stopped the turn: the next prompt sent lets them
   *  go, ahead of it. */
  paused?: boolean;
}) {
  if (queue.length === 0) return null;
  return (
    <section className="studio-queue" aria-label="Queued messages">
      <p className="studio-queue-label">
        {paused ? "Queued · held since you stopped the turn; your next message goes after them" : "Queued · sends when the current turn ends"}
      </p>
      <ol>
        {queue.map((prompt) => {
          // Comments on the diff it carries are counted, not spelled out.
          const { text, quotes } = parseCommentQuotes(prompt.text);
          return (
            <li key={prompt.id} className="studio-queue-item">
              {prompt.mode === "plan" && (
                <span className="studio-queue-files" title="Goes in plan mode">
                  <ListChecks aria-hidden />
                  Plan
                </span>
              )}
              <span className="studio-queue-text" title={text}>
                {text || (quotes.length > 0 ? "Comments only" : "Files only")}
              </span>
              {quotes.length > 0 && (
                <span className="studio-queue-files" title={`${quotes.length} comment${quotes.length === 1 ? "" : "s"} on the diff`}>
                  <MessageSquareText aria-hidden />
                  {quotes.length}
                </span>
              )}
              {prompt.attachmentIds.length > 0 && (
                <span className="studio-queue-files" title={`${prompt.attachmentIds.length} attached`}>
                  <Paperclip aria-hidden />
                  {prompt.attachmentIds.length}
                </span>
              )}
              <button
                type="button"
                onClick={() => onSendNow(prompt)}
                disabled={!canSendNow}
                title="Send now: the agent takes it at its next step"
                aria-label="Send now"
              >
                <ArrowUp aria-hidden />
                Send now
              </button>
              <button type="button" onClick={() => onRemove(prompt)} title="Remove from the queue" aria-label="Remove">
                <X aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
