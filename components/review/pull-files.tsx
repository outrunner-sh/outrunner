"use client";

import { ChevronRight, MessageSquare, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Delta, KindIcon, LineCountsSummary } from "@/components/review/line-counts";
import { pickQuote, type QuoteIntent, usePickedQuote } from "@/components/review/quote-store";
import { StartTourButton, TourCard, useTour } from "@/components/review/review-tour";
import type { DiffLine } from "@/lib/runtime/diff";
import { selectionFromLines } from "@/lib/session/diff-comments";
import { type Hunk, type PullFile, splitHunks } from "@/lib/review/hunks";
import { byKindThenPath, type LineCounts } from "@/lib/review/line-kinds";
import { cn } from "@/lib/utils";

function rowClass(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10";
    case "del":
      return "bg-rose-500/10";
    case "meta":
      return "text-muted-foreground/70";
    default:
      return "";
  }
}

const marker = (type: DiffLine["type"]) => (type === "add" ? "+" : type === "del" ? "-" : " ");

/** The file's name, and the folder it's in dimmed: the name is what a
 *  reviewer looks for. */
function FilePath({ file }: { file: PullFile }) {
  const at = file.path.lastIndexOf("/");
  return (
    <span className="min-w-0 truncate font-mono text-[12px]" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
      {at > 0 && <span className="text-muted-foreground">{file.path.slice(0, at + 1)}</span>}
      <span className="text-foreground">{file.path.slice(at + 1)}</span>
    </span>
  );
}

/** Lines picked in one hunk: where the pick started and where it ends now,
 *  as places in the hunk's lines. */
type Picked = { hunkId: string; anchor: number; focus: number };

/** Picking lines: what's picked, and the ways to pick, extend, ask and
 *  drop. */
type Picking = {
  picked: Picked | null;
  pick: (hunk: Hunk, index: number, extend: boolean) => void;
  quote: (hunk: Hunk, intent: QuoteIntent) => void;
  clear: () => void;
};

const pickable = (line: DiffLine) =>
  (line.type === "add" || line.type === "context" || line.type === "del") && (line.oldNumber !== undefined || line.newNumber !== undefined);

function HunkView({ hunk, focused, picking }: { hunk: Hunk; focused: boolean; picking: Picking }) {
  const ref = useRef<HTMLDivElement>(null);
  // The tour's current hunk is brought into view, below the tour's card.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focused]);
  // A drag down the gutter picks a range, until the button is let go.
  const dragging = useRef(false);
  useEffect(() => {
    const release = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, []);
  const picked = picking.picked?.hunkId === hunk.id ? picking.picked : null;
  const from = picked ? Math.min(picked.anchor, picked.focus) : -1;
  const to = picked ? Math.max(picked.anchor, picked.focus) : -1;
  const selection = picked ? selectionFromLines(hunk.lines, from, to) : null;
  return (
    <div
      ref={ref}
      data-hunk={hunk.id}
      className={cn("scroll-mt-60 transition-shadow", focused && "relative z-[1] ring-2 ring-sky-500/70 ring-inset")}
    >
      <div className="bg-muted/60 px-2 py-0.5 text-muted-foreground">{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const canPick = pickable(line);
        const gutter = canPick
          ? {
              onPointerDown: (event: React.PointerEvent) => {
                if (event.button !== 0) return;
                event.preventDefault();
                dragging.current = true;
                picking.pick(hunk, i, event.shiftKey);
              },
              className: "w-10 shrink-0 cursor-pointer select-none px-1 text-right text-muted-foreground/50 hover:text-foreground",
            }
          : { className: "w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50" };
        return (
          <div key={i}>
            <div
              className={cn("flex", rowClass(line.type), selection && i >= from && i <= to && "bg-sky-500/20")}
              onPointerEnter={canPick ? () => dragging.current && picking.pick(hunk, i, true) : undefined}
              // Shift-click extends the pick, not the page's text selection.
              onMouseDown={canPick ? (event) => event.shiftKey && event.preventDefault() : undefined}
              onClick={
                canPick
                  ? (event) => {
                      // A drag across the code is copying it, not picking lines.
                      if (window.getSelection()?.toString()) return;
                      picking.pick(hunk, i, event.shiftKey);
                    }
                  : undefined
              }
            >
              <span {...gutter}>{line.oldNumber ?? ""}</span>
              <span {...gutter}>{line.newNumber ?? ""}</span>
              <span className="w-4 shrink-0 select-none text-center text-muted-foreground">{marker(line.type)}</span>
              <span className="flex-1 whitespace-pre-wrap break-all pr-2">{line.text}</span>
            </div>
            {selection && i === to && (
              <div className="flex items-center gap-2 border-y border-sky-500/30 bg-sky-500/5 px-3 py-1.5 font-sans text-[12px]">
                <span className="text-muted-foreground">
                  {selection.side === "old" ? "Removed " : ""}
                  {selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}–${selection.endLine}`}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => picking.quote(hunk, "ask")}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <MessageSquare className="size-3.5" />
                    Ask
                  </button>
                  <button
                    type="button"
                    onClick={() => picking.quote(hunk, "change")}
                    className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-0.5 text-background hover:opacity-90"
                  >
                    <Wand2 className="size-3.5" />
                    Ask for a change
                  </button>
                  <button type="button" onClick={picking.clear} className="p-1 text-muted-foreground hover:text-foreground" aria-label="Drop the picked lines">
                    <X className="size-3.5" />
                  </button>
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileView({
  file,
  open,
  onToggle,
  focus,
  picking,
}: {
  file: PullFile;
  open: boolean;
  onToggle: () => void;
  focus: string | null;
  picking: Picking;
}) {
  const hunks = useMemo(() => splitHunks(file.path, file.patch), [file.path, file.patch]);
  return (
    <section data-file={file.path} className="overflow-hidden rounded-lg border border-border/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <KindIcon kind={file.kind} />
        <FilePath file={file} />
        {file.status !== "modified" && <span className="shrink-0 text-[11px] text-muted-foreground">{file.status}</span>}
        <Delta delta={file} dim={file.kind === "generated"} className="ml-auto shrink-0 text-[12px]" />
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-border/60 font-mono text-[11px] leading-relaxed">
          {hunks.length === 0 ? (
            <p className="px-3 py-2 font-sans text-[12px] text-muted-foreground">
              {file.patch === null ? "Binary, or too large for GitHub to show here." : "No changes to show."}
            </p>
          ) : (
            hunks.map((hunk) => <HunkView key={hunk.id} hunk={hunk} focused={hunk.id === focus} picking={picking} />)
          )}
        </div>
      )}
    </section>
  );
}

/** Generated files and ones too big to read at a glance start folded. */
const FOLD_OVER_LINES = 800;
const startsOpen = (file: PullFile) => file.kind !== "generated" && file.additions + file.deletions <= FOLD_OVER_LINES;

/**
 * A pull request's changed files, each with its kind and lines, and its diff
 * hunk by hunk: code first, then tests, then what a tool wrote, folded. And
 * the guided tour through them, which opens, scrolls to and highlights the
 * hunk each step is on. Lines picked in a hunk (click, shift-click or drag
 * the gutter) can be quoted to the chat, to ask about or to ask for a change.
 */
export function PullFiles({
  repo,
  number,
  headSha,
  files,
  complete,
  lines,
  changedFiles,
}: {
  repo: string;
  number: number;
  headSha: string;
  /** Null when GitHub didn't list them. */
  files: PullFile[] | null;
  /** False when only some were read. */
  complete: boolean;
  lines: LineCounts | null;
  changedFiles: number;
}) {
  const tour = useTour(repo, number, headSha);
  const [picked, setPicked] = useState<Picked | null>(null);
  // Lines quoted to the chat stay picked while it holds them; once it has
  // sent or dropped them, so does the diff.
  const quoted = usePickedQuote(`${repo}#${number}`);
  const wasQuoted = useRef(false);
  useEffect(() => {
    if (wasQuoted.current && !quoted) setPicked(null);
    wasQuoted.current = quoted !== null;
  }, [quoted]);
  const picking: Picking = {
    picked,
    pick: (hunk, index, extend) =>
      setPicked((current) =>
        extend && current?.hunkId === hunk.id ? { ...current, focus: index } : { hunkId: hunk.id, anchor: index, focus: index },
      ),
    quote: (hunk, intent) => {
      if (picked?.hunkId !== hunk.id) return;
      const selection = selectionFromLines(hunk.lines, picked.anchor, picked.focus);
      if (selection) pickQuote(`${repo}#${number}`, { path: hunk.path, ...selection }, intent);
    },
    clear: () => setPicked(null),
  };
  const focus = tour.focus;
  const focusFile = focus ? focus.slice(0, focus.lastIndexOf("#")) : null;
  const ordered = useMemo(
    () => [...(files ?? [])].sort(byKindThenPath),
    [files],
  );
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <h2 className="font-medium text-foreground">
          Files <span className="text-muted-foreground">{changedFiles}</span>
        </h2>
        <span className="flex items-center gap-3 text-[12px]">
          {lines && complete && <LineCountsSummary counts={lines} />}
          {files !== null && <StartTourButton tour={tour} />}
        </span>
      </div>
      <TourCard tour={tour} />
      {files === null ? (
        <p className="text-[12px] text-muted-foreground">GitHub didn&apos;t list this PR&apos;s files. Reload to try again.</p>
      ) : (
        !complete && (
          <p className="text-[12px] text-muted-foreground">
            Showing {files.length} of {changedFiles} files, so their lines by kind are left out.
          </p>
        )
      )}
      {ordered.map((file) => (
        <FileView
          key={file.path}
          file={file}
          // The tour's file is open while it's on it, however it was left.
          open={file.path === focusFile || startsOpen(file) !== toggled.has(file.path)}
          onToggle={() => toggle(file.path)}
          focus={focus}
          picking={picking}
        />
      ))}
    </div>
  );
}
