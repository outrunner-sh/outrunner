"use client";

import { ArrowUp, Check, ChevronDown, FileText, Hammer, Loader2, Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAttachments } from "@/hooks/use-attachments";
import { matchModel, modelLabel, type ModelGroup, type SessionModel } from "@/lib/runtime/session-models";

/**
 * The prompt composer pinned at the bottom of the conversation column. Sending
 * writes the text (plus a carriage return) into the live PTY, which is how a
 * prompt reaches Claude Code. Disabled unless this viewer holds the keyboard.
 *
 * Files can ride along: picked, dropped, or pasted. They upload immediately
 * rather than on send, so the wait happens while the user is still typing, and
 * `onSend` receives their ids to attach server-side.
 */

/** Switching the session's model from the footer, where the session allows it. */
export type ModelChoice = {
  groups: ModelGroup[];
  onChange: (model: SessionModel) => void;
  /** Why it can't switch right now (mid-turn, not at the keyboard); null when
   *  it can. */
  disabledReason: string | null;
  switching: boolean;
};

export function SessionComposer({
  onSend,
  canSend,
  disabledPlaceholder = "Read-only — another viewer has the keyboard",
  model,
  modelChoice,
  allowAttachments = true,
}: {
  onSend: (text: string, attachmentIds: string[]) => void;
  canSend: boolean;
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
        // A file dropped where it cannot be attached must still be caught:
        // left to the browser, the drop navigates the page to the file and
        // away from the session. Text drags are left alone.
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (canSend && allowAttachments) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        if (!canSend || !allowAttachments) return;
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
          {modelChoice ? (
            <ModelPicker model={model} choice={modelChoice} />
          ) : (
            model && <span className="studio-composer-model">{modelLabel(model)}</span>
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

/** The footer's model, as a menu of the models the session can switch to. */
function ModelPicker({ model, choice }: { model?: string; choice: ModelChoice }) {
  const current = matchModel(choice.groups, model);
  const label = choice.switching
    ? "Switching…"
    : (current?.label ?? (model ? modelLabel(model) : "Model"));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="studio-composer-model studio-composer-model-picker"
          disabled={choice.switching || choice.disabledReason !== null}
          title={choice.disabledReason ?? "Switch model"}
          aria-label={`Model: ${label}. Switch model`}
        >
          {choice.switching && <Loader2 className="animate-spin" />}
          {label}
          <ChevronDown />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-52">
        {choice.groups.map((group, i) => (
          <div key={group.label}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {group.label}
            </DropdownMenuLabel>
            {group.models.map((m) => (
              <DropdownMenuItem
                key={m.id}
                // Always sent, even for the ticked family: the session may run an
                // older model of it, and the agent ignores a switch to what it has.
                onSelect={() => choice.onChange(m)}
              >
                <Check className={m.id === current?.id ? "opacity-100" : "opacity-0"} />
                {m.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
