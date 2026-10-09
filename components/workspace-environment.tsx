"use client";

import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  GitPullRequest,
  Monitor,
  PanelRightClose,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { WorkspaceChanges } from "@/components/workspace-changes";
import { WorkspacePublishPanel } from "@/components/workspace-publish-panel";
import { useWorkspaceChanges, type WorkspaceChangesState } from "@/hooks/use-workspace-changes";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { changeTotals, environmentSummary } from "@/lib/session/environment";
import { cn } from "@/lib/utils";

/**
 * The session's Environment: where it runs, its changes, its branch and its
 * pull request, one quiet row each. Changes opens the file list in place; the
 * branch and pull request rows unfold their details beneath them. The terminal
 * docks below, in the studio's slot, not here.
 */
export function WorkspaceEnvironment({
  workspace,
  local,
  pullRequest,
  isReady,
  terminalOpen,
  onClose,
}: {
  workspace: Workspace;
  local?: LocalSession;
  pullRequest: WorkspacePullRequest | null;
  isReady: boolean;
  /** The terminal below is expanded: the rows then take only their height. */
  terminalOpen: boolean;
  /** Closes the panel; shown where the panel covers the chat (narrow windows). */
  onClose: () => void;
}) {
  const [view, setView] = useState<"overview" | "changes">("overview");
  // Focus follows the view: into the list's back arrow on the way in, back to
  // the Changes row on the way out, so the keyboard is never left on nothing.
  const changesRow = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (view === "changes") backButton.current?.focus();
    else if (returning.current) changesRow.current?.focus();
    returning.current = false;
  }, [view]);
  const backToOverview = () => {
    returning.current = true;
    setView("overview");
  };
  const [open, setOpen] = useState<"branch" | "pr" | null>(null);
  const changes = useWorkspaceChanges({ workspaceId: workspace.id, local: local !== undefined, active: isReady });
  const summary = environmentSummary(workspace, local);
  const unfold = (row: "branch" | "pr") => setOpen((current) => (current === row ? null : row));

  // Both views stay mounted, the one not in use hidden: leaving the overview
  // for Changes (or folding the PR row) must not throw away a pull request
  // being written there.
  return (
    <>
      {view === "changes" && (
        <div className="studio-env-body">
          <WorkspaceChanges
            changes={changes}
            active={isReady}
            baseBranch={summary.baseBranch}
            onBack={backToOverview}
            backRef={backButton}
          />
        </div>
      )}
      <div hidden={view === "changes"} className={cn("studio-env-body", terminalOpen && "is-compact")}>
        <div className="studio-env-label">
          Environment
          <button type="button" onClick={onClose} className="studio-env-close" title="Hide environment" aria-label="Hide environment">
            <PanelRightClose />
          </button>
        </div>

        <EnvRow
          icon={summary.location.kind === "local" ? <Monitor /> : <Cloud />}
          title={summary.location.detail}
        >
          {summary.location.label}
        </EnvRow>

        <EnvRow
          ref={changesRow}
          onClick={() => setView("changes")}
          icon={<Plus />}
          right={
            <>
              <ChangesCount changes={changes} active={isReady} />
              <ChevronRight />
            </>
          }
        >
          Changes
        </EnvRow>

        <EnvRow
          onClick={() => unfold("branch")}
          expanded={open === "branch"}
          icon={<GitBranch />}
          right={<ChevronDown className={cn("transition-transform", open === "branch" && "rotate-180")} />}
        >
          <span className="truncate">{summary.branch ?? "No branch"}</span>
        </EnvRow>
        {open === "branch" && (
          <dl className="studio-env-details">
            {summary.branch ? (
              <>
                <dt>Compared with</dt>
                <dd className="font-mono">{summary.baseBranch ?? "—"}</dd>
              </>
            ) : (
              <dd className="col-span-2">Not a git repository: Claude edits the folder in place.</dd>
            )}
            {summary.workingPath && (
              <>
                <dt>Working in</dt>
                <dd className="font-mono" title={summary.workingPath}>{summary.workingPath}</dd>
              </>
            )}
          </dl>
        )}

        {/* Publishing goes through the server, which reaches cloud worktrees
            only; a local session's branch stays in the folder's repository. */}
        {!local && summary.branch && (
          <>
            <EnvRow
              onClick={() => unfold("pr")}
              expanded={open === "pr"}
              icon={<GitPullRequest />}
              right={<ChevronDown className={cn("transition-transform", open === "pr" && "rotate-180")} />}
            >
              {pullRequest ? `PR #${pullRequest.number}` : "Create PR"}
            </EnvRow>
            {/* Folded, not unmounted: the draft survives closing the row. */}
            <div hidden={open !== "pr"} className="studio-env-unfold">
              <WorkspacePublishPanel
                workspaceId={workspace.id}
                branch={summary.branch}
                baseBranch={summary.baseBranch ?? workspace.baseBranch}
                pullRequest={pullRequest}
                active={isReady}
                defaultTitle={workspace.title}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** The Changes row's `+3 −0`, or what stands in for it. */
function ChangesCount({ changes, active }: { changes: WorkspaceChangesState; active: boolean }) {
  if (!active) return null;
  if (changes.message) return <span title={changes.message}>Unavailable</span>;
  if (changes.files === null) return <Spinner label="Loading changes" />;
  const totals = changeTotals(changes.files);
  return (
    <span title={`${totals.files} file${totals.files === 1 ? "" : "s"} changed`}>
      <span className="text-positive">+{totals.additions}</span>{" "}
      <span className="text-destructive">-{totals.deletions}</span>
    </span>
  );
}

/** One row: icon, what it is, and a count or chevron on the right. With
 *  `onClick` it is a button; `expanded` marks one that unfolds details. */
function EnvRow({
  ref,
  icon,
  right,
  title,
  onClick,
  expanded,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  icon: React.ReactNode;
  right?: React.ReactNode;
  title?: string;
  onClick?: () => void;
  expanded?: boolean;
  children: React.ReactNode;
}) {
  const content = (
    <>
      <span className="studio-env-icon">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {right && <span className="studio-env-right">{right}</span>}
    </>
  );
  if (!onClick) {
    return (
      <div title={title} className="studio-env-row">
        {content}
      </div>
    );
  }
  return (
    <button ref={ref} type="button" onClick={onClick} title={title} aria-expanded={expanded} className="studio-env-row is-action">
      {content}
    </button>
  );
}
