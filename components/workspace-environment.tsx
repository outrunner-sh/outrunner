"use client";

import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  PanelRightClose,
  Plus,
  ScanSearch,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { SessionMediaRows } from "@/components/session-media";
import { EnvRow } from "@/components/studio-env-row";
import { Spinner } from "@/components/ui/loaders";
import { WorkspaceChanges } from "@/components/workspace-changes";
import type { SessionSender } from "@/components/workspace-session";
import { uploadAttachment } from "@/hooks/use-attachments";
import { useWorkspaceChanges, type WorkspaceChangesState } from "@/hooks/use-workspace-changes";
import { openPendingTab, TAB_BLOCKED } from "@/lib/client/pending-tab";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { PullRequestStatus } from "@/lib/github/client";
import { opensInBrowser, type Workspace, type WorkspacePullRequest } from "@/lib/runtime/types";
import { changeTotals, environmentSummary } from "@/lib/session/environment";
import { PR_INSTRUCTIONS_FILENAME, PR_PROMPT, prInstructions } from "@/lib/session/pr-instructions";
import { pullRequestVerdict, type PullRequestVerdict } from "@/lib/session/pull-request-status";
import {
  REVIEW_INSTRUCTIONS_FILENAME,
  REVIEW_PROMPT,
  reviewInstructions,
} from "@/lib/session/review-instructions";
import { cn } from "@/lib/utils";

/**
 * The session's Environment: its changes, its branch, its pull request and,
 * once that is open, a review, one quiet row each. Changes opens the file list
 * in place; the branch row unfolds its details beneath it, the pull request
 * row asks the agent for one and then links to the pull request it opens, and
 * Review asks the agent to review it. The terminal docks below, in the
 * studio's slot, not here.
 */
export function WorkspaceEnvironment({
  workspace,
  local,
  pullRequest,
  isReady,
  sender,
  onClose,
}: {
  workspace: Workspace;
  local?: LocalSession;
  pullRequest: WorkspacePullRequest | null;
  isReady: boolean;
  /** Sends into the session while it can (the Create PR and Review prompts). */
  sender: SessionSender | null;
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
            workspaceId={workspace.id}
            changes={changes}
            active={isReady}
            baseBranch={summary.baseBranch}
            onBack={backToOverview}
            backRef={backButton}
            onClose={onClose}
          />
        </div>
      )}
      <div hidden={view === "changes"} className="studio-env-body">
        <div className="studio-env-label">
          <button type="button" onClick={onClose} className="studio-env-close" title="Hide environment" aria-label="Hide environment">
            <PanelRightClose />
          </button>
        </div>

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

        {/* Cloud sessions only: Create PR and Review hand the agent their
            instructions as an attachment, which a session on this Mac can't
            take. Review shows under the pull request once there is one. */}
        {!local && summary.branch && !workspace.checkouts && (
          <PullRequestRow
            workspaceId={workspace.id}
            branch={summary.branch}
            baseBranch={summary.baseBranch ?? workspace.baseBranch}
            uncommitted={isReady && changes.files ? changes.files.length : null}
            pullRequest={pullRequest}
            sender={isReady ? sender : null}
          />
        )}
        {/* A session of several repositories: a pull request in each, a row
            a repository, each counting its own folder's changes. */}
        {!local &&
          summary.branch &&
          workspace.checkouts?.map((c) => (
            <PullRequestRow
              key={c.projectId}
              workspaceId={workspace.id}
              branch={summary.branch!}
              baseBranch={c.baseBranch}
              uncommitted={isReady && changes.files ? changes.files.filter((f) => f.path.startsWith(`${c.checkout}/`)).length : null}
              pullRequest={pullRequest?.projectId === c.projectId ? pullRequest : null}
              sender={isReady ? sender : null}
              repo={{ projectId: c.projectId, checkout: c.checkout, fullName: c.fullName }}
            />
          ))}

        {/* The servers running on a cloud session's box, each a click from
            the user's browser. */}
        {!local && opensInBrowser(workspace.provider) && <PortRows workspaceId={workspace.id} active={isReady} />}

        {/* What the session's agent uploaded to show its work: screenshots
            and GIFs for its pull request. */}
        {!local && <SessionMediaRows workspaceId={workspace.id} />}
      </div>
    </>
  );
}

/** How often the panel looks for servers started or stopped on the box. */
const PORTS_POLL_MS = 10_000;

type ListedPort = { port: number; process?: string };

/**
 * A row for each server running on the session's box (a dev server, an API),
 * looked for while the session is up and its page is in view. A click opens
 * it in a tab through the box's preview link. Nothing shows while there are
 * none, or where they can't be read: the agent on an older box, or the box
 * paused.
 */
function PortRows({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const [ports, setPorts] = useState<ListedPort[]>([]);
  const [opening, setOpening] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A session that stops (its box paused) runs nothing: the list it had goes,
  // and any error with it, so neither comes back with the session, stale.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setPorts([]);
      setError(null);
    }
  }

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const look = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/ports`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { ports?: ListedPort[] } | null;
        if (!stopped && res.ok && body?.ports) setPorts(body.ports);
      } catch {
        // Unreachable for now: the list stays as it was, and the next look tries again.
      }
    };
    void look();
    const timer = setInterval(() => void look(), PORTS_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void look();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, active]);

  // A session that's no longer up runs nothing to open.
  if (!active || ports.length === 0) return null;

  async function open(port: number) {
    setOpening(port);
    setError(null);
    const tab = openPendingTab(`Opening port ${port}…`);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/ports/${port}`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error ?? "Couldn't open that preview. Please try again.");
      if (tab.closed()) return;
      if (!tab.go(body.url)) setError(TAB_BLOCKED);
    } catch (e) {
      tab.close();
      setError(e instanceof Error ? e.message : "Couldn't open that preview. Please try again.");
    } finally {
      setOpening(null);
    }
  }

  return (
    <>
      <div className="studio-env-label mt-3">Running</div>
      {ports.map(({ port, process }) => (
        <EnvRow
          key={port}
          onClick={() => void open(port)}
          busy={opening === port}
          icon={opening === port ? <Spinner /> : <Globe />}
          right={<ArrowUpRight />}
          title={`Open port ${port} in a new tab`}
        >
          <span className="font-mono text-xs tabular-nums">{port}</span>
          {process && <span className="ml-2 truncate text-xs text-muted-foreground">{process}</span>}
        </EnvRow>
      ))}
      {error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** How often, and for how long, the row looks for the pull request the agent
 *  was asked to open. Long enough for an agent that commits, pushes and writes
 *  a description; the page looking again on its next load covers the rest. */
const PR_POLL_MS = 15_000;
const PR_WAIT_MS = 10 * 60_000;
/** How often an open pull request's status (checks, mergeability) is re-read. */
const PR_STATUS_POLL_MS = 30_000;
/** How often a PR closed unmerged is looked at again, for one that takes its
 *  place: each look is two calls to GitHub (its status, then the branch's
 *  newest PR), for a PR most often abandoned. */
const PR_CLOSED_POLL_MS = 120_000;
/** How long Merge waits for its confirming second click. */
const MERGE_CONFIRM_MS = 4_000;

type RowError = { message: string; reconnect: boolean };

/**
 * Hand the agent a job the way Conductor does: a short prompt with the steps
 * attached as a markdown file, sent through the session like a message typed
 * in the composer. Shared by Create PR and Review so the two cannot drift.
 *
 * `error` is set only for a failure the chat won't show: a send that fails
 * says why there, and its orphaned attachment is cleaned up here.
 */
async function askAgent(
  sender: SessionSender,
  prompt: string,
  filename: string,
  instructions: string,
): Promise<{ sent: boolean; error?: string }> {
  let attachment: { id: string };
  try {
    attachment = await uploadAttachment(new File([instructions], filename, { type: "text/markdown" }));
  } catch (uploadError) {
    const reason = uploadError instanceof Error ? uploadError.message : "Upload failed";
    return { sent: false, error: `Could not attach ${filename}: ${reason}.` };
  }
  const sent = await sender.send(prompt, [attachment.id]);
  if (!sent) void fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(() => {});
  return { sent };
}

/**
 * Review asks the session's agent to review its open pull request, as
 * Conductor's Review request does: the prompt "Review my changes" with
 * `Review request.md` attached. The findings come back as the agent's final
 * message, so unlike Create PR this row has nothing to watch for once the
 * prompt is away.
 */
function ReviewRow({
  baseBranch,
  pullRequestNumber,
  sender,
  repo,
}: {
  baseBranch: string;
  /** The open pull request under review. */
  pullRequestNumber: number;
  sender: SessionSender | null;
  /** One repository of a session of several: its pull request's review. */
  repo?: { checkout: string; fullName: string };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review() {
    if (!sender || busy) return;
    setBusy(true);
    setError(null);
    const result = await askAgent(
      sender,
      REVIEW_PROMPT,
      REVIEW_INSTRUCTIONS_FILENAME,
      reviewInstructions({ baseBranch, pullRequestNumber, ...(repo && { repo }) }),
    );
    setError(result.error ?? null);
    setBusy(false);
  }

  return (
    <>
      <EnvRow
        onClick={() => void review()}
        disabled={!sender}
        busy={busy}
        icon={<ScanSearch />}
        title={
          !sender ? "Available once the session is connected" : `Ask the agent to review pull request #${pullRequestNumber}`
        }
        right={busy ? <Spinner label="Asking for a review" /> : undefined}
      >
        Review
      </EnvRow>
      {error && (
        <p aria-live="polite" className="studio-env-unfold text-destructive pt-0 text-xs">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The session's pull request. Without one, Create PR asks the session's agent
 * to open it, as Conductor does: the prompt "Create a PR" with
 * `PR instructions.md` attached, sent through the session like a message typed
 * in the composer; the row then watches GitHub for it. With one, the row links
 * to it, says where it stands, and offers Merge once it is green.
 */
function PullRequestRow({
  workspaceId,
  branch,
  baseBranch,
  uncommitted,
  pullRequest,
  sender,
  repo,
}: {
  workspaceId: string;
  branch: string;
  baseBranch: string;
  /** Files changed and not committed, null while unknown. */
  uncommitted: number | null;
  pullRequest: WorkspacePullRequest | null;
  sender: SessionSender | null;
  /** One repository of a session of several: the row is its pull request's. */
  repo?: { projectId: string; checkout: string; fullName: string };
}) {
  const router = useRouter();
  const [found, setFound] = useState<WorkspacePullRequest | null>(null);
  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "sending" | "waiting">("idle");
  const [error, setError] = useState<RowError | null>(null);
  // A repository's row of a session of several starts without its pull
  // request (the page loads the session's own one's): until the first look
  // says whether it has one, Create PR waits, so it can't ask for a second.
  const [looked, setLooked] = useState(!repo);
  // When the last answer was applied: an effect re-run by it (looked turning
  // true changes the poll) doesn't look again at once.
  const lastLook = useRef(0);
  const opened = found ?? pullRequest;
  const hasPullRequest = opened !== null;
  const openedNumber = opened?.number ?? null;
  // Looked for every PR_POLL_MS while the agent is at it, re-read every
  // PR_STATUS_POLL_MS while open, and left alone once merged. One closed
  // unmerged is still read, less often (PR_CLOSED_POLL_MS): the agent may open
  // another from the branch, which takes its place.
  const settled = status !== null && status.state !== "open";
  // A first look that didn't get an answer is tried again, so Create PR
  // isn't offered blind.
  const pollMs = hasPullRequest
    ? status?.state === "merged"
      ? null
      : status?.state === "closed"
        ? PR_CLOSED_POLL_MS
        : PR_STATUS_POLL_MS
    : phase === "waiting" || (!looked && !error?.reconnect)
      ? PR_POLL_MS
      : null;

  // Also looks once on opening: the agent may have opened one since the page
  // loaded, or without being asked. Only a sign-in GitHub refused is worth
  // saying; anything else, the next look may get past, and a status that
  // couldn't be read keeps the last one.
  useEffect(() => {
    let live = true;
    const look = async () => {
      const result = await lookUpPullRequest(workspaceId, repo?.projectId);
      // Only an answer applied counts: one thrown away (the effect torn down
      // mid-look) leaves the re-run to look itself.
      if (!live) return;
      lastLook.current = Date.now();
      if (result.answered) setLooked(true);
      if (result.pullRequest) {
        // Its first, or one that took over from a PR closed unmerged.
        if (result.pullRequest.number !== openedNumber) {
          setFound(result.pullRequest);
          setPhase("idle");
          router.refresh();
        }
        if (result.status) {
          setStatus(result.status);
          // GitHub answered with the sign-in, so a Reconnect GitHub error is
          // stale. Not on the pull request alone: one on record comes back
          // without asking GitHub. Any other error (a failed merge) stays.
          setError((e) => (e?.reconnect ? null : e));
        }
      } else if (result.reconnect) {
        setError({ message: result.error ?? "Reconnect GitHub to see the pull request.", reconnect: true });
      }
    };
    if (Date.now() - lastLook.current > PR_POLL_MS / 2) void look();
    if (pollMs === null) return () => void (live = false);
    const poll = setInterval(() => void look(), pollMs);
    const giveUp = hasPullRequest ? undefined : setTimeout(() => setPhase("idle"), PR_WAIT_MS);
    return () => {
      live = false;
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [hasPullRequest, openedNumber, pollMs, workspaceId, router, repo?.projectId]);

  const errorLine = error && (
    <p aria-live="polite" className="studio-env-unfold text-destructive pt-0 text-xs">
      {error.message}
      {error.reconnect && <GitHubReconnectLink />}
    </p>
  );

  if (opened) {
    return (
      <>
        <OpenedPullRequestRow
          workspaceId={workspaceId}
          pullRequest={opened}
          repo={repo}
          status={status}
          onStatus={setStatus}
          onError={setError}
        />
        {errorLine}
        {/* While it's open: a merged or closed one has nothing left to review. */}
        {!settled && <ReviewRow baseBranch={baseBranch} pullRequestNumber={opened.number} sender={sender} repo={repo} />}
      </>
    );
  }

  async function createPr() {
    if (!sender || phase !== "idle") return;
    setPhase("sending");
    setError(null);
    const result = await askAgent(
      sender,
      PR_PROMPT,
      PR_INSTRUCTIONS_FILENAME,
      prInstructions({ branch, baseBranch, uncommitted, ...(repo && { repo }) }),
    );
    if (result.error) setError({ message: result.error, reconnect: false });
    setPhase(result.sent ? "waiting" : "idle");
  }

  const busy = phase !== "idle";
  return (
    <>
      <EnvRow
        onClick={() => void createPr()}
        disabled={!sender || !looked}
        busy={busy}
        icon={<GitPullRequest />}
        title={
          !sender
            ? "Available once the session is connected"
            : !looked
              ? error?.reconnect
                ? "Reconnect GitHub to check for a pull request first"
                : "Checking for a pull request"
              : phase === "waiting"
              ? "The agent is creating the pull request; it shows here once it's open"
              : `Ask the agent to commit, push ${branch} and open a pull request into ${baseBranch}${repo ? ` on ${repo.fullName}` : ""}`
        }
        right={busy ? <Spinner label="Creating pull request" /> : undefined}
      >
        Create PR
        {repo && <span className="ml-2 truncate font-mono text-xs text-white/45">{repo.checkout}/</span>}
      </EnvRow>
      {errorLine}
    </>
  );
}

/** The verdict's colour in the row. */
const VERDICT_TONE: Record<PullRequestVerdict["tone"], string> = {
  ready: "text-positive",
  pending: "text-white/45",
  problem: "text-destructive",
  done: "text-white/45",
  merged: "text-merged",
};

/**
 * `#99 ↗  Ready to merge  [Merge]`, after Conductor's bar. Merge takes a
 * second click to confirm, and merges the head commit the status was read at.
 */
function OpenedPullRequestRow({
  workspaceId,
  pullRequest,
  repo,
  status,
  onStatus,
  onError,
}: {
  workspaceId: string;
  pullRequest: WorkspacePullRequest;
  repo?: { projectId: string; checkout: string; fullName: string };
  status: PullRequestStatus | null;
  onStatus: (status: PullRequestStatus) => void;
  onError: (error: RowError | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const verdict = status ? pullRequestVerdict(status) : null;
  const merged = verdict?.tone === "merged";

  useEffect(() => {
    if (!confirming) return;
    const reset = setTimeout(() => setConfirming(false), MERGE_CONFIRM_MS);
    return () => clearTimeout(reset);
  }, [confirming]);

  async function merge() {
    if (!status || merging) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setMerging(true);
    onError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/pull-request/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headSha: status.headSha, ...(repo && { projectId: repo.projectId }) }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        status?: PullRequestStatus | null;
        error?: string;
        reconnect?: boolean;
      };
      if (!response.ok) {
        onError({ message: result.error ?? "Could not merge the pull request.", reconnect: result.reconnect === true });
        return;
      }
      onStatus(result.status ?? { ...status, state: "merged" });
    } catch {
      onError({ message: "Could not reach Outrunner. Please try again.", reconnect: false });
    } finally {
      setMerging(false);
    }
  }

  return (
    <EnvRow
      // A merged PR carries GitHub's merge glyph, in its colour: the row reads
      // as done at a glance, not as one still open.
      icon={merged ? <GitMerge /> : <GitPullRequest />}
      merged={merged}
      right={
        verdict?.canMerge && (
          <button
            type="button"
            onClick={() => void merge()}
            aria-busy={merging || undefined}
            className="studio-env-merge"
            title={`Merge #${pullRequest.number} into ${pullRequest.baseBranch} on GitHub`}
          >
            {merging ? <Spinner label="Merging" /> : <GitMerge />}
            {/* The confirm step keeps its words while the merge runs. */}
            {merging || confirming ? "Confirm merge" : "Merge"}
          </button>
        )
      }
    >
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        title={`Open pull request #${pullRequest.number} on GitHub`}
        className="studio-env-pr-link"
      >
        {repo && <span className="mr-1.5 font-mono text-xs text-white/45">{repo.checkout}/</span>}
        #{pullRequest.number}
        <ArrowUpRight />
      </a>
      {/* Ready to merge goes without saying beside Merge, and left in it was
          cut to "Ready to …". */}
      {verdict && !verdict.canMerge && (
        <span className={cn("ml-3 truncate text-sm", VERDICT_TONE[verdict.tone])}>{verdict.label}</span>
      )}
    </EnvRow>
  );
}

/** The session's pull request and its status as the server finds them, or
 *  why it couldn't. */
async function lookUpPullRequest(workspaceId: string, projectId?: string): Promise<{
  /** Outrunner said whether there is one (a 2xx); not a failed request. */
  answered?: boolean;
  pullRequest?: WorkspacePullRequest | null;
  status?: PullRequestStatus | null;
  error?: string;
  reconnect?: boolean;
}> {
  try {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/workspaces/${workspaceId}/pull-request${query}`, { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as Awaited<ReturnType<typeof lookUpPullRequest>>;
    return { ...body, answered: response.ok };
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
    <span title={`${totals.files} file${totals.files === 1 ? "" : "s"} changed`} className="font-mono text-xs tabular-nums">
      <span className="text-positive">+{totals.additions}</span>{" "}
      <span className="text-destructive">-{totals.deletions}</span>
    </span>
  );
}
