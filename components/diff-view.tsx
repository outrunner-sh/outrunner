"use client";

import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { parseUnifiedDiff, type DiffLine } from "@/lib/runtime/diff";
import { type DiffComment, type DiffSelection, selectionFromLines } from "@/lib/session/diff-comments";
import { isImeKeydown } from "@/lib/session/composing";
import { cn } from "@/lib/utils";

// Redundant per-file headers the panel already conveys (it shows the path); hide
// them so the diff reads clean like a source-control view, keeping only hunk
// headers, body lines, and informative notices (binary / no-newline).
const REDUNDANT_META = /^(diff --git|index |--- |\+\+\+ |old mode|new mode|similarity |rename )/;

function rowClass(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10 text-emerald-300";
    case "del":
      return "bg-rose-500/10 text-rose-300";
    case "hunk":
      return "bg-muted/60 text-muted-foreground";
    case "meta":
      return "text-muted-foreground/70";
    default:
      return "text-foreground/90";
  }
}

const marker = (type: DiffLine["type"]) => (type === "add" ? "+" : type === "del" ? "-" : " ");

/** Commenting on a file's lines: the comments it has, and the ways to add and
 *  remove one. */
export type DiffCommenting = {
  items: DiffComment[];
  onAdd: (selection: DiffSelection, comment: string) => void;
  onRemove: (id: string) => void;
};

// A line is named by its numbers rather than its place in the list: the diff
// is read again as the agent edits the file, and a selection (or a comment
// half written on it) should stay on the same lines when it is.
const lineId = (line: DiffLine) => `${line.oldNumber ?? ""}/${line.newNumber ?? ""}`;
const pickable = (line: DiffLine) =>
  (line.type === "add" || line.type === "context" || line.type === "del") &&
  (line.oldNumber !== undefined || line.newNumber !== undefined);

/** "line 12" or "lines 12–18", and whether they are the old file's. */
function linesLabel({ side, startLine, endLine }: Pick<DiffComment, "side" | "startLine" | "endLine">): string {
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  return side === "old" ? `removed ${lines}` : lines;
}

/** Where a comment shows: under the last line it is on, while the diff still
 *  has that line. */
function noteRow(lines: DiffLine[], comment: DiffComment): number {
  if (comment.side === "new") return lines.findIndex((l) => l.type !== "del" && l.newNumber === comment.endLine);
  const removed = lines.findIndex((l) => l.type === "del" && l.oldNumber === comment.endLine);
  return removed !== -1 ? removed : lines.findIndex((l) => l.oldNumber === comment.endLine);
}

/** Render a bounded unified diff inline with red/green lines + a line-number
 *  gutter. Pure presentation over {@link parseUnifiedDiff}. Given `commenting`,
 *  its lines can be picked (click; shift-click or drag the gutter for a range)
 *  and commented on, and the file's comments show under their lines. */
export function DiffView({ diff, commenting }: { diff: string; commenting?: DiffCommenting }) {
  const lines = useMemo(
    () => parseUnifiedDiff(diff).filter((line) => !(line.type === "meta" && REDUNDANT_META.test(line.text))),
    [diff],
  );
  const [picked, setPicked] = useState<{ anchor: string; focus: string } | null>(null);
  const [draft, setDraft] = useState("");
  // A drag down the gutter extends the range until the button is let go,
  // wherever that is.
  const dragging = useRef(false);
  useEffect(() => {
    if (!commenting) return;
    const release = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, [commenting]);

  if (lines.length === 0) {
    return <p className="text-muted-foreground text-xs">No diff to show.</p>;
  }

  const anchor = picked ? lines.findIndex((l) => pickable(l) && lineId(l) === picked.anchor) : -1;
  const focus = picked ? lines.findIndex((l) => pickable(l) && lineId(l) === picked.focus) : -1;
  const from = Math.min(anchor, focus);
  const to = Math.max(anchor, focus);
  const selection = commenting && anchor !== -1 && focus !== -1 ? selectionFromLines(lines, from, to) : null;

  const pick = (index: number, extend: boolean) => {
    const id = lineId(lines[index]);
    setPicked((current) => (extend && current ? { anchor: current.anchor, focus: id } : { anchor: id, focus: id }));
  };
  const cancel = () => {
    setPicked(null);
    setDraft("");
  };
  const save = () => {
    if (!commenting || !selection || !draft.trim()) return;
    commenting.onAdd(selection, draft.trim());
    cancel();
  };

  const notes = new Map<number, DiffComment[]>();
  const unplaced: DiffComment[] = [];
  for (const comment of commenting?.items ?? []) {
    const at = noteRow(lines, comment);
    if (at === -1) unplaced.push(comment);
    else notes.set(at, [...(notes.get(at) ?? []), comment]);
  }
  const note = (comment: DiffComment) => (
    <DiffNote key={comment.id} comment={comment} onRemove={() => commenting?.onRemove(comment.id)} />
  );

  return (
    <div className="max-h-96 overflow-auto rounded-md border font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        const canPick = !!commenting && pickable(line);
        const selected = selection !== null && i >= from && i <= to && pickable(line);
        // The gutter is the handle: press to pick a line, drag for a range.
        const gutter = canPick
          ? {
              onPointerDown: (event: React.PointerEvent) => {
                if (event.button !== 0) return;
                event.preventDefault();
                dragging.current = true;
                pick(i, event.shiftKey);
              },
            }
          : {};
        return (
          <div key={i}>
            <div
              className={cn("flex", rowClass(line.type), canPick && "studio-diff-line", selected && "is-selected")}
              onPointerEnter={canPick ? () => dragging.current && pick(i, true) : undefined}
              // Shift-click extends the range, not the page's text selection.
              onMouseDown={canPick ? (event) => event.shiftKey && event.preventDefault() : undefined}
              onClick={
                canPick
                  ? (event) => {
                      // A drag across the code is copying it, not picking lines.
                      if (window.getSelection()?.toString()) return;
                      // A comment half written stays on its lines: a click
                      // elsewhere mustn't move it to others unseen. Shift
                      // extends its range, and the gutter picks afresh.
                      if (draft.trim() && !event.shiftKey) return;
                      pick(i, event.shiftKey);
                    }
                  : undefined
              }
            >
              <span {...gutter} className="text-muted-foreground/50 w-8 shrink-0 select-none px-1 text-right">
                {line.oldNumber ?? ""}
              </span>
              <span {...gutter} className="text-muted-foreground/50 w-8 shrink-0 select-none px-1 text-right">
                {line.newNumber ?? ""}
              </span>
              <span className="w-3 shrink-0 select-none text-center">{marker(line.type)}</span>
              <span className="flex-1 break-all whitespace-pre-wrap pr-2">{line.text}</span>
            </div>
            {notes.get(i)?.map(note)}
            {selection && i === to && (
              <DiffCommentForm
                label={linesLabel(selection)}
                value={draft}
                onChange={setDraft}
                onSave={save}
                onCancel={cancel}
              />
            )}
          </div>
        );
      })}
      {unplaced.map(note)}
    </div>
  );
}

/** The box for a comment on the picked lines, just under them. */
function DiffCommentForm({
  label,
  value,
  onChange,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="studio-diff-comment-form"
      onKeyDown={(event) => {
        if (isImeKeydown(event.nativeEvent)) return;
        if (event.key === "Escape") {
          // The Changes panel's Escape goes back to the environment: here it
          // only drops the comment.
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSave();
        }
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`Comment on ${label}…`}
        aria-label={`Comment on ${label}`}
      />
      <div className="studio-diff-comment-actions">
        <span>Sent with your next message</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="is-primary" onClick={onSave} disabled={!value.trim()} title="Comment (⌘↵)">
          Comment
        </button>
      </div>
    </div>
  );
}

/** A comment waiting for the next message, under the lines it is on. */
function DiffNote({ comment, onRemove }: { comment: DiffComment; onRemove: () => void }) {
  const label = linesLabel(comment);
  return (
    <div className="studio-diff-note">
      <div className="studio-diff-note-head">
        <span>{label[0].toUpperCase() + label.slice(1)}</span>
        <button type="button" onClick={onRemove} title="Remove comment" aria-label={`Remove comment on ${label}`}>
          <X />
        </button>
      </div>
      <p>{comment.comment}</p>
    </div>
  );
}
