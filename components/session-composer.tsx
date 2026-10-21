"use client";

import { ArrowUp, Check, FileText, Plus, Search, Settings2, Square, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/loaders";
import { useAttachments } from "@/hooks/use-attachments";
import { attachNotice, restoreDraft } from "@/lib/runtime/attachments";
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
import { effortOnPick, loadoutModels, type ModelLoadout, searchModels } from "@/lib/runtime/model-loadout";
import {
  costHint,
  DEFAULT_EFFORT,
  type Effort,
  EFFORT_LABELS,
  EFFORTS,
  matchModel,
  modelLabel,
  type ModelGroup,
  type ModelProvider,
  type SessionModel,
  takesEffort,
} from "@/lib/runtime/session-models";
import { isImeKeydown } from "@/lib/session/composing";
import { AGENTS, type AgentId } from "@/lib/agents/registry";
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
 */

/** Switching the session's model, and the effort it runs at, from the footer,
 *  where the session allows it. */
export type ModelChoice = {
  groups: ModelGroup[];
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

export function SessionComposer({
  onSend,
  canSend,
  placeholder = "Ask anything, / for commands, @ for context…",
  disabledPlaceholder = "Read-only — another viewer has the keyboard",
  model,
  modelChoice,
  allowAttachments = true,
  stop,
}: {
  /** Send a prompt. When it returns a promise of whether the send landed, a
   *  failed send gives the text and files back to the composer. */
  onSend: (text: string, attachmentIds: string[]) => void | Promise<boolean>;
  canSend: boolean;
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
  /** Stopping the turn under way, shown beside send (and on Escape) while
   *  there is one to stop. */
  stop?: { onStop: () => void; stopping: boolean };
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // dragenter/dragleave fire for every child the pointer crosses; the outline
  // follows the count, so it does not flicker on the way across.
  const dragDepth = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();

  // A notice says something once, then gets out of the way.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // A prompt of only attachments is legitimate — "here's a screenshot".
  const hasSomethingToSend = value.trim() !== "" || attachments.readyIds.length > 0;

  /** Stage files, or say why they cannot be (attachNotice). */
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    const blocked = attachNotice({ allowed: allowAttachments, canSend, skipped: 0 });
    if (blocked) {
      setNotice(blocked);
      return;
    }
    setNotice(attachNotice({ allowed: true, canSend: true, skipped: attachments.add(files) }));
  }

  function submit() {
    if (!canSend || sending || !hasSomethingToSend || attachments.busy) return;
    const text = value.trim();
    // What this send carries, kept apart from whatever is typed or attached
    // while it is in flight: only these are settled when it lands.
    const sentIds = attachments.readyIds;
    const result = onSend(text, sentIds);
    setValue("");
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
    if (!result) {
      attachments.forget(sentIds);
      return;
    }
    // The sent files stay on show until the send lands. A failed send gives
    // its text back, ahead of anything typed since, so nothing is lost.
    setSending(true);
    void result
      .then((landed) => {
        if (landed) {
          attachments.forget(sentIds);
        } else {
          setValue((current) => restoreDraft(text, current));
          textareaRef.current?.focus();
        }
      })
      .finally(() => setSending(false));
  }

  return (
    <form
      className="studio-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        if (canSend && allowAttachments) setDragging(true);
      }}
      onDragOver={(event) => {
        // A file dropped where it cannot be attached must still be caught:
        // left to the browser, the drop navigates the page to the file and
        // away from the session. Text drags are left alone.
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
      style={dragging ? { outline: "1px dashed currentColor", outlineOffset: 4 } : undefined}
    >
      {notice && (
        <p role="status" className="studio-composer-notice">
          {notice}
        </p>
      )}
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
                <Spinner className="size-3 shrink-0" />
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
        placeholder={canSend ? placeholder : disabledPlaceholder}
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
          if (files.length > 0) {
            event.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(event) => {
          // Not while an input method is composing: there, Enter confirms the
          // characters (Japanese, Chinese…) rather than sending half a prompt.
          if (event.key === "Enter" && !event.shiftKey && !isImeKeydown(event.nativeEvent)) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && stop && !stop.stopping && !isImeKeydown(event.nativeEvent)) {
            event.preventDefault();
            stop.onStop();
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
          {modelChoice ? (
            <ModelPicker model={model} choice={modelChoice} />
          ) : (
            model && <span className="studio-composer-model">{modelLabel(model)}</span>
          )}
        </span>
        <span>
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
            disabled={!canSend || sending || !hasSomethingToSend || attachments.busy}
            aria-label="Send"
          >
            <ArrowUp />
          </button>
        </span>
      </div>
    </form>
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
function ModelPicker({ model, choice }: { model?: string; choice: ModelChoice }) {
  // A group on the user's own key offers the ids they typed in before, and
  // takes another (CustomModelDialog).
  const [customFor, setCustomFor] = useState<TypedModelProvider | null>(null);
  const [query, setQuery] = useState("");
  const groups = choice.groups.map((group) => {
    const own = group.custom && takesTypedModels(group.provider) ? group.provider : null;
    if (!own) return { ...group, own };
    const typed = rememberedCustomModels(own).filter((m) => !group.models.some((listed) => listed.id === m.id));
    return { ...group, own, models: [...group.models, ...typed] };
  });
  const current = matchModel(groups, model, choice.preferredProvider);
  const name = current?.label ?? (model ? modelLabel(model) : "Model");
  // The effort shows only where it does something.
  const effort = current && takesEffort(current) ? choice.effort : undefined;
  const label = choice.switching
    ? "Switching model"
    : effort === undefined
      ? name
      : `${name}, ${effortName(effort)} effort`;
  const loadout = choice.loadout ? loadoutModels(choice.loadout, groups) : [];
  const searching = query.trim() !== "";
  // Searching looks through everything; otherwise the loadout, where there is
  // one, stands in for the groups.
  const flat = searching ? searchModels(groups.flatMap((g) => g.models), query) : loadout;
  const showGroups = !searching && loadout.length === 0;
  const isCurrent = (m: SessionModel) => m.id === current?.id && m.provider === current.provider;
  const item = (m: SessionModel) => (
    <DropdownMenuItem
      key={`${m.provider}:${m.id}`}
      // Always sent, even for the ticked family: the session may run an
      // older model of it, and the agent ignores a switch to what it has.
      // The same model keeps its effort; another runs at the loadout's for
      // it, else DEFAULT_EFFORT.
      onSelect={() => choice.onChange(m, isCurrent(m) ? choice.effort : effortOnPick(choice.loadout, m))}
    >
      <ModelIcon provider={m.provider} />
      {/* The current model in the brand's colour, as a tick would mark it. */}
      <span className={cn("flex-1 truncate", isCurrent(m) && "text-brand")}>{m.label}</span>
      <span className={cn("text-xs tabular-nums text-muted-foreground", isCurrent(m) && "text-brand")}>
        {costHint(m)}
      </span>
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="studio-composer-model studio-composer-model-picker"
            disabled={choice.switching || choice.disabledReason !== null}
            title={choice.disabledReason ?? "Switch model"}
            aria-label={`Model: ${label}. Switch model`}
          >
            {/* Both labels share one cell, so the footer holds still while the
                name gives way to "Switching" and back. */}
            <span className="grid place-items-center">
              <span className={cn("col-start-1 row-start-1 inline-flex items-center gap-2", choice.switching && "invisible")}>
                {name}
                {effort !== undefined && <EffortMeter effort={effort} />}
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
        {/* On the composer's own black, not the theme's grey popover. */}
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-72 border-(--studio-border) bg-(--studio-bg)"
        >
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
                    <DropdownMenuItem onSelect={() => setCustomFor(group.own)}>
                      <Check className="opacity-0" />
                      <span className="text-muted-foreground">Other model…</span>
                    </DropdownMenuItem>
                  ) : null}
                </div>
              ))
            : flat.map(item)}
          {searching && flat.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No model matches “{query.trim()}”.</p>
          ) : null}
          {/* Without the groups, their way to type a model in stays here. */}
          {!showGroups && groups.some((group) => group.own) ? <DropdownMenuSeparator /> : null}
          {!showGroups
            ? groups.flatMap((group) =>
                group.own ? (
                  <DropdownMenuItem key={`other:${group.provider}`} onSelect={() => setCustomFor(group.own)}>
                    <ModelIcon provider={group.provider} />
                    <span className="text-muted-foreground">Other {typedModelOwner(group.own).label} model…</span>
                  </DropdownMenuItem>
                ) : [],
              )
            : null}
          {!searching && choice.connect.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              {choice.connect.map((agent) => (
                <DropdownMenuItem key={`connect:${agent}`} asChild>
                  <Link href={providerSettingsHref(agent)}>
                    <AgentIcon agent={agent} />
                    <span className="flex-1 truncate">Connect {AGENTS[agent].label}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {current && effort !== undefined ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {current.label} effort
              </DropdownMenuLabel>
              {[null, ...EFFORTS].map((level) => (
                <DropdownMenuItem key={level ?? "default"} onSelect={() => choice.onChange(current, level)}>
                  <EffortMeter effort={level} />
                  <span className="flex-1 truncate">{level ? EFFORT_LABELS[level] : effortName(null)}</span>
                  <Check className={level === effort ? "opacity-100" : "opacity-0"} />
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomModelDialog
        provider={customFor}
        onOpenChange={(open) => {
          if (!open) setCustomFor(null);
        }}
        onChoose={(provider, id) => {
          rememberCustomModel(provider, id);
          choice.onChange({ id, label: id, provider }, DEFAULT_EFFORT);
        }}
      />
    </>
  );
}
