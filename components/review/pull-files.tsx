"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Delta, KindIcon, LineCountsSummary } from "@/components/review/line-counts";
import { StartTourButton, TourCard, useTour } from "@/components/review/review-tour";
import type { DiffLine } from "@/lib/runtime/diff";
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

function HunkView({ hunk, focused }: { hunk: Hunk; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // The tour's current hunk is brought into view, below the tour's card.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focused]);
  return (
    <div
      ref={ref}
      data-hunk={hunk.id}
      className={cn("scroll-mt-60 transition-shadow", focused && "relative z-[1] ring-2 ring-sky-500/70 ring-inset")}
    >
      <div className="bg-muted/60 px-2 py-0.5 text-muted-foreground">{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={cn("flex", rowClass(line.type))}>
          <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50">{line.oldNumber ?? ""}</span>
          <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50">{line.newNumber ?? ""}</span>
          <span className="w-4 shrink-0 select-none text-center text-muted-foreground">{marker(line.type)}</span>
          <span className="flex-1 whitespace-pre-wrap break-all pr-2">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function FileView({ file, open, onToggle, focus }: { file: PullFile; open: boolean; onToggle: () => void; focus: string | null }) {
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
            hunks.map((hunk) => <HunkView key={hunk.id} hunk={hunk} focused={hunk.id === focus} />)
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
 * hunk each step is on.
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
          {lines && <LineCountsSummary counts={lines} />}
          {files !== null && <StartTourButton tour={tour} />}
        </span>
      </div>
      <TourCard tour={tour} />
      {files === null ? (
        <p className="text-[12px] text-muted-foreground">GitHub didn&apos;t list this PR&apos;s files. Reload to try again.</p>
      ) : (
        !complete && (
          <p className="text-[12px] text-muted-foreground">
            Showing {files.length} of {changedFiles} files.
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
        />
      ))}
    </div>
  );
}
