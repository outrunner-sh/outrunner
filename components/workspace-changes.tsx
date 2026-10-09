"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";

import { DiffView } from "@/components/diff-view";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/loaders";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import type { WorkspaceChangesState } from "@/hooks/use-workspace-changes";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "@/lib/runtime/types";
import { changeTotals } from "@/lib/session/environment";

const statusVariant: Record<ChangedFile["status"], "default" | "secondary" | "outline" | "destructive"> = {
  added: "default",
  modified: "secondary",
  deleted: "destructive",
  renamed: "outline",
  untracked: "outline",
};

/**
 * Conductor-style changes list: a single scrollable list of changed files, each
 * an inline expandable diff. No separate "select a file" pane. Opened from the
 * Environment panel's Changes row; `onBack` returns to it. The data (and its
 * polling) is the panel's, from useWorkspaceChanges.
 */
export function WorkspaceChanges({
  changes,
  active,
  baseBranch,
  onBack,
  backRef,
}: {
  changes: WorkspaceChangesState;
  active: boolean;
  baseBranch?: string | null;
  onBack: () => void;
  backRef?: React.Ref<HTMLButtonElement>;
}) {
  const { files, message, diffs, diffErrors, openPaths, toggle } = changes;
  const hasChanges = !!files && files.length > 0;
  const totals = changeTotals(files ?? []);

  return (
    // Esc steps back out of the list, as the back arrow does.
    <div
      className="studio-changes"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="studio-changes-head">
        <button ref={backRef} type="button" onClick={onBack} className="studio-icon-button" title="Back to environment" aria-label="Back to environment">
          <ArrowLeft />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">
            {hasChanges ? `${totals.files} file${totals.files === 1 ? "" : "s"} changed` : "Changes"}
            {hasChanges && (
              <span className="ml-2 font-mono text-[11px] font-normal">
                <span className="text-emerald-500">+{totals.additions}</span>{" "}
                <span className="text-red-400">-{totals.deletions}</span>
              </span>
            )}
          </p>
          {baseBranch && <p className="truncate text-[11px] text-muted-foreground">Compared with {baseBranch}</p>}
        </div>
      </div>

      {!active ? (
        <div className="studio-changes-empty">Changes are available once the workspace is ready.</div>
      ) : (
        <SkeletonSwap
          ready={files !== null || message !== null}
          // One bar per file row (38px), from where the path starts.
          skeleton={<SkeletonRows rows={4} rowHeight={38} indent={40} />}
          label="Changes"
          className="studio-changes-scroll"
        >
          <div>
            {message && <p aria-live="polite" className="px-4 py-3 text-destructive text-xs">{message}</p>}
            {files && files.length === 0 && !message && (
              <p className="px-4 py-8 text-center text-muted-foreground text-xs">No uncommitted changes.</p>
            )}
            {hasChanges &&
              files!.map((file) => {
                const isOpen = openPaths.has(file.path);
                const diff = diffs.get(file.path);
                const diffError = diffErrors.get(file.path);
                return (
                  <div key={file.path} className="studio-diff-file">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggle(file.path)}
                      className="studio-diff-file-head"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-90",
                        )}
                      />
                      <Badge variant={statusVariant[file.status]} className="shrink-0 capitalize">
                        {file.status}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file.path}</span>
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-emerald-500">+{file.additions}</span>{" "}
                        <span className="text-red-400">-{file.deletions}</span>
                      </span>
                    </button>
                    {isOpen && (
                      <div className="studio-diff-file-body">
                        {diff !== undefined ? (
                          <DiffView diff={diff} />
                        ) : diffError !== undefined ? (
                          <p aria-live="polite" className="px-3 py-2 text-destructive text-xs">{diffError}</p>
                        ) : (
                          <p className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground text-xs">
                            <Spinner className="size-3.5" /> Loading diff…
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </SkeletonSwap>
      )}
    </div>
  );
}
