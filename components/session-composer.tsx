"use client";

import { ArrowUp, ChevronDown, FileText, Hammer, Loader2, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { useAttachments } from "@/hooks/use-attachments";

/**
 * The prompt composer pinned at the bottom of the conversation column. Sending
 * writes the text (plus a carriage return) into the live PTY, which is how a
 * prompt reaches Claude Code. Disabled unless this viewer holds the keyboard.
 *
 * Files can ride along: picked, dropped, or pasted. They upload immediately
 * rather than on send, so the wait happens while the user is still typing, and
 * `onSend` receives their ids to attach server-side.
 */

/** Trim Claude's model id to a stable label — drop a trailing -YYYYMMDD date so
 *  "claude-opus-4-5-20250115" reads as "claude-opus-4-5". */
function formatModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function SessionComposer({
  onSend,
  canSend,
  disabledPlaceholder = "Read-only — another viewer has the keyboard",
  model,
  allowAttachments = true,
}: {
  onSend: (text: string, attachmentIds: string[]) => void;
  canSend: boolean;
  /** Placeholder shown when input is disabled (offline, reader, connecting…). */
  disabledPlaceholder?: string;
  /** The Claude model in use, shown in the footer. Omitted before any assistant
   *  turn has arrived (and on the new-session form, which has no session yet). */
  model?: string;
  /** False hides attaching. Attachments are delivered by the server, which
   *  cannot reach a local session's worktree on the user's Mac. */
  allowAttachments?: boolean;
}) {
  const [value, setValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();

  // A prompt of only attachments is legitimate — "here's a screenshot".
  const hasSomethingToSend = value.trim() !== "" || attachments.readyIds.length > 0;

  function submit() {
    if (!canSend || !hasSomethingToSend || attachments.busy) return;
    onSend(value.trim(), attachments.readyIds);
    setValue("");
    attachments.clear();
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  }

  return (
    <form
      className="studio-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        if (!canSend || !allowAttachments) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!canSend || !allowAttachments) return;
        event.preventDefault();
        setDragging(false);
        void attachments.add(Array.from(event.dataTransfer.files));
      }}
      style={dragging ? { outline: "1px dashed currentColor", outlineOffset: 4 } : undefined}
    >
      {attachments.items.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-1 pb-2">
          {attachments.items.map((item) => (
            <li
              key={item.key}
              className="border-border bg-background/60 flex max-w-52 items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
              title={item.error ?? item.filename}
            >
              {item.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.previewUrl}
                  alt=""
                  className="size-6 shrink-0 rounded object-cover"
                />
              ) : (
                <FileText className="text-muted-foreground size-4 shrink-0" />
              )}
              <span
                className={`truncate ${item.status === "error" ? "text-destructive" : ""}`}
              >
                {item.status === "error" ? (item.error ?? "Failed") : item.filename}
              </span>
              {item.status === "uploading" && (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              )}
              <button
                type="button"
                onClick={() => attachments.remove(item.key)}
                aria-label={`Remove ${item.filename}`}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={
          canSend
            ? "Ask anything, / for commands, @ for context…"
            : disabledPlaceholder
        }
        aria-label="Message Claude"
        spellCheck={false}
        disabled={!canSend}
        onChange={(event) => {
          setValue(event.target.value);
          const el = event.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }}
        onPaste={(event) => {
          // Pasted screenshots arrive as files on the clipboard. Only intercept
          // when there are some, so ordinary text paste is untouched.
          const files = Array.from(event.clipboardData.files);
          if (files.length > 0 && allowAttachments) {
            event.preventDefault();
            void attachments.add(files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="studio-composer-footer">
        <span>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void attachments.add(Array.from(event.target.files ?? []));
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
          <span className="studio-composer-tag">
            <Hammer style={{ width: 12, marginRight: 4, display: "inline" }} />
            Build
            <ChevronDown style={{ width: 11, marginLeft: 2, display: "inline" }} />
          </span>
          {model && (
            <span className="studio-composer-model">{formatModel(model)}</span>
          )}
        </span>
        <button
          type="submit"
          className="studio-composer-send"
          disabled={!canSend || !hasSomethingToSend || attachments.busy}
          aria-label="Send"
        >
          <ArrowUp />
        </button>
      </div>
    </form>
  );
}
