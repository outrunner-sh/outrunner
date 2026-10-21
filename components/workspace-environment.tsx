"use client";

import {
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Monitor,
  PanelRightClose,
  Plus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { Spinner } from "@/components/ui/loaders";
import { WorkspaceChanges } from "@/components/workspace-changes";
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
  const [branchOpen, setBranchOpen] = useState(false);
  const changes = useWorkspaceChanges({ workspaceId: workspace.id, local: local !== undefined, active: isReady });
  const summary = environmentSummary(workspace, local);

  // Both views stay mounted, the one not in use hidden: leaving the overview
  // for Changes must not lose a pull request being opened, or its error.
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
          onClick={() => setBranchOpen((current) => !current)}
          expanded={branchOpen}
          icon={<GitBranch />}
          right={<ChevronDown className={cn("transition-transform", branchOpen && "rotate-180")} />}
        >
          <span className="truncate">{summary.branch ?? "No branch"}</span>
        </EnvRow>
        {branchOpen && (
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
          <PullRequestRow
            workspaceId={workspace.id}
            branch={summary.branch}
            baseBranch={summary.baseBranch ?? workspace.baseBranch}
            pullRequest={pullRequest}
            active={isReady}
          />
        )}
      </div>
    </>
  );
}

/**
 * Create PR in one click: the server commits what's left as the owner, pushes
 * the branch and opens a pull request titled after the session. Once there is
 * one, the row is a link to it.
 */
function PullRequestRow({
  workspaceId,
  branch,
  baseBranch,
  pullRequest,
  active,
}: {
  workspaceId: string;
  branch: string;
  baseBranch: string;
  pullRequest: WorkspacePullRequest | null;
  active: boolean;
}) {
  const router = useRouter();
  const [created, setCreated] = useState<WorkspacePullRequest | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const opened = created ?? pullRequest;

  if (opened) {
    return (
      <EnvRow
        href={opened.url}
        icon={<GitPullRequest />}
        title={`Pull request into ${opened.baseBranch}`}
        right={<ExternalLink />}
      >
        PR #{opened.number}
      </EnvRow>
    );
  }

  async function publish() {
    if (publishing || !active) return;
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await response.json().catch(() => ({}))) as {
        pullRequest?: WorkspacePullRequest;
        error?: string;
        reconnect?: boolean;
      };
      if (!response.ok || !result.pullRequest) {
        setError({
          message: result.error ?? "Could not create the pull request. Please try again.",
          reconnect: result.reconnect === true,
        });
        return;
      }
      setCreated(result.pullRequest);
      router.refresh();
    } catch {
      setError({ message: "Could not reach Outrunner. Please try again.", reconnect: false });
    } finally {
      setPublishing(false);
    }
  }

  return (
    <>
      <EnvRow
        onClick={() => void publish()}
        disabled={!active}
        busy={publishing}
        icon={<GitPullRequest />}
        title={
          active
            ? `Commit all changes, push ${branch} and open a pull request into ${baseBranch}`
            : "Available once the workspace is ready"
        }
        right={publishing ? <Spinner label="Creating pull request" /> : undefined}
      >
        {publishing ? "Creating PR…" : error ? "Retry Create PR" : "Create PR"}
      </EnvRow>
      {error && (
        <p aria-live="polite" className="studio-env-unfold text-destructive pt-0 text-xs">
          {error.message}
          {error.reconnect && <GitHubReconnectLink />}
        </p>
      )}
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
 *  `onClick` it is a button (`expanded` marks one that unfolds details, `busy`
 *  one at work, which ignores clicks); with `href`, a link out. */
function EnvRow({
  ref,
  icon,
  right,
  title,
  onClick,
  href,
  expanded,
  disabled,
  busy,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  icon: React.ReactNode;
  right?: React.ReactNode;
  title?: string;
  onClick?: () => void;
  href?: string;
  expanded?: boolean;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const content = (
    <>
      <span className="studio-env-icon">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {right && <span className="studio-env-right">{right}</span>}
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" title={title} className="studio-env-row is-action">
        {content}
      </a>
    );
  }
  if (!onClick) {
    return (
      <div title={title} className="studio-env-row">
        {content}
      </div>
    );
  }
  // Busy is not disabled: the button keeps its focus and just ignores clicks.
  return (
    <button
      ref={ref}
      type="button"
      onClick={busy ? undefined : onClick}
      title={title}
      aria-expanded={expanded}
      aria-busy={busy || undefined}
      disabled={disabled}
      className="studio-env-row is-action disabled:cursor-not-allowed disabled:opacity-50"
    >
      {content}
    </button>
  );
}
