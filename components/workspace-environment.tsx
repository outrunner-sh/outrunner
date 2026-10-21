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
import type { SessionSender } from "@/components/workspace-session";
import { uploadAttachment } from "@/hooks/use-attachments";
import { useWorkspaceChanges, type WorkspaceChangesState } from "@/hooks/use-workspace-changes";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { changeTotals, environmentSummary } from "@/lib/session/environment";
import { PR_INSTRUCTIONS_FILENAME, PR_PROMPT, prInstructions } from "@/lib/session/pr-instructions";
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
  sender,
  terminalOpen,
  onClose,
}: {
  workspace: Workspace;
  local?: LocalSession;
  pullRequest: WorkspacePullRequest | null;
  isReady: boolean;
  /** Sends into the session while it can (Create PR's prompt). */
  sender: SessionSender | null;
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
  // for Changes must not stop the watch for a pull request being opened.
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

        {/* Cloud sessions only: the instructions go as an attachment, which a
            session on this Mac can't take. */}
        {!local && summary.branch && (
          <PullRequestRow
            workspaceId={workspace.id}
            branch={summary.branch}
            baseBranch={summary.baseBranch ?? workspace.baseBranch}
            uncommitted={isReady && changes.files ? changes.files.length : null}
            pullRequest={pullRequest}
            sender={isReady ? sender : null}
          />
        )}
      </div>
    </>
  );
}

/** How often, and for how long, the row looks for the pull request the agent
 *  was asked to open. Long enough for an agent that commits, pushes and writes
 *  a description; the page looking again on its next load covers the rest. */
const PR_POLL_MS = 15_000;
const PR_WAIT_MS = 10 * 60_000;

/**
 * Create PR asks the session's agent to open one, as Conductor does: the
 * prompt "Create a PR" with `PR instructions.md` attached, sent through the
 * session like a message typed in the composer. The row then watches GitHub
 * for the pull request on the branch, and once there is one, links to it.
 */
function PullRequestRow({
  workspaceId,
  branch,
  baseBranch,
  uncommitted,
  pullRequest,
  sender,
}: {
  workspaceId: string;
  branch: string;
  baseBranch: string;
  /** Files changed and not committed, null while unknown. */
  uncommitted: number | null;
  pullRequest: WorkspacePullRequest | null;
  sender: SessionSender | null;
}) {
  const router = useRouter();
  const [found, setFound] = useState<WorkspacePullRequest | null>(null);
  const [phase, setPhase] = useState<"idle" | "sending" | "waiting">("idle");
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const opened = found ?? pullRequest;

  // Looks once on opening (the agent may have opened one since the page
  // loaded, or without being asked), then every PR_POLL_MS while waiting.
  // Only a sign-in GitHub refused is worth saying: anything else, the next
  // look may get past.
  useEffect(() => {
    if (opened) return;
    let live = true;
    const look = async () => {
      const result = await lookUpPullRequest(workspaceId);
      if (!live) return;
      if (result.pullRequest) {
        setFound(result.pullRequest);
        setPhase("idle");
        router.refresh();
      } else if (result.reconnect) {
        setError({ message: result.error ?? "Reconnect GitHub to see the pull request.", reconnect: true });
      }
    };
    void look();
    if (phase !== "waiting") return () => void (live = false);
    const poll = setInterval(() => void look(), PR_POLL_MS);
    const giveUp = setTimeout(() => setPhase("idle"), PR_WAIT_MS);
    return () => {
      live = false;
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [opened, phase, workspaceId, router]);

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

  async function createPr() {
    if (!sender || phase !== "idle") return;
    setPhase("sending");
    setError(null);
    let attachment: { id: string };
    try {
      const instructions = prInstructions({ branch, baseBranch, uncommitted });
      attachment = await uploadAttachment(
        new File([instructions], PR_INSTRUCTIONS_FILENAME, { type: "text/markdown" }),
      );
    } catch (uploadError) {
      const reason = uploadError instanceof Error ? uploadError.message : "Upload failed";
      setError({ message: `Could not attach the PR instructions: ${reason}.`, reconnect: false });
      setPhase("idle");
      return;
    }
    // A send that fails says why in the chat, as the composer's do.
    const sent = await sender.send(PR_PROMPT, [attachment.id]);
    if (!sent) void fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(() => {});
    setPhase(sent ? "waiting" : "idle");
  }

  const busy = phase !== "idle";
  return (
    <>
      <EnvRow
        onClick={() => void createPr()}
        disabled={!sender}
        busy={busy}
        icon={<GitPullRequest />}
        title={
          !sender
            ? "Available once the session is connected"
            : phase === "waiting"
              ? "The agent is creating the pull request; it shows here once it's open"
              : `Ask the agent to commit, push ${branch} and open a pull request into ${baseBranch}`
        }
        right={busy ? <Spinner label="Creating pull request" /> : undefined}
      >
        {busy ? "Creating PR…" : "Create PR"}
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

/** The session's pull request as the server finds it, or why it couldn't. */
async function lookUpPullRequest(
  workspaceId: string,
): Promise<{ pullRequest?: WorkspacePullRequest | null; error?: string; reconnect?: boolean }> {
  try {
    const response = await fetch(`/api/workspaces/${workspaceId}/pull-request`, { cache: "no-store" });
    return (await response.json().catch(() => ({}))) as {
      pullRequest?: WorkspacePullRequest | null;
      error?: string;
      reconnect?: boolean;
    };
  } catch {
    return {};
  }
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
