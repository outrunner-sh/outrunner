"use client";

import Link from "next/link";
import {
  ArrowLeft,
  FileDiff,
  MessageSquarePlus,
  PanelRightClose,
  Plus,
  Terminal,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState } from "react";

import { LocalSessionsNav } from "@/components/local-sessions-nav";
import { ProjectWorkspaceNav } from "@/components/project-workspace-nav";
import { WorkspaceChanges } from "@/components/workspace-changes";
import { SessionComposer } from "@/components/session-composer";
import { WorkspaceSession } from "@/components/workspace-session";
import { localSessionLabel } from "@/lib/desktop/local-sessions";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

export function WorkspaceStudio({
  workspace,
  local,
  allProjects,
  allWorkspaces,
  initialPrompt,
  initialAttachmentIds,
}: {
  workspace: Workspace;
  /** Set for a local session, which runs on this Mac and is driven through the
   *  Outrunner app rather than the server. */
  local?: LocalSession;
  allProjects: Project[];
  allWorkspaces: Workspace[];
  /** Kept for the page contract; the Publish panel was removed from the studio. */
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
  /** Attachment ids staged on the home composer, sent with the first prompt. */
  initialAttachmentIds?: string[];
}) {
  const [rightOpen, setRightOpen] = useState(true);
  // The live terminal is tucked away by default; it is where Claude's own
  // prompts are answered — in a local session, every shell-command approval.
  const [showTerminal, setShowTerminal] = useState(false);
  const isLocal = local !== undefined;
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && (workspace.provider === "daytona" || isLocal);
  const offline = offlineCopy({ workspace, isReady });

  return (
    <div className={cn("studio-shell", !rightOpen && "no-inspector")}>
      <aside className="studio-sidebar">
        <div className="studio-brand"><Terminal /> outrunner</div>
        <div className="studio-sidebar-top">
          <Link href="/" className="studio-back"><ArrowLeft /> Home</Link>
          <Link href="/new" className="studio-back" title="New session"><Plus /> New</Link>
        </div>
        <LocalSessionsNav activeWorkspaceId={workspace.id} />
        <ProjectWorkspaceNav
          projects={allProjects}
          workspaces={allWorkspaces}
          activeWorkspaceId={workspace.id}
        />
      </aside>

      <section className="studio-chat">
        <header className="studio-chat-header">
          <div className="studio-title">
            <span className={cn("studio-status", `is-${workspace.status}`)} />
            <div>
              <h2>{local ? localSessionLabel(local) : workspace.branch}</h2>
              <p title={workspace.worktreePath || undefined}>
                {local
                  ? `${local.name} · ${local.inPlace ? "in place" : local.branch} · this Mac`
                  : `${workspace.provider} worktree · ${workspace.status}`}
              </p>
            </div>
          </div>
          <div className="studio-header-actions">
            {hasLiveSession && (
              <button
                className={cn("studio-icon-button", showTerminal && "is-active")}
                onClick={() => setShowTerminal((open) => !open)}
                title={showTerminal ? "Hide terminal" : "Show terminal"}
                aria-pressed={showTerminal}
              >
                <TerminalSquare />
              </button>
            )}
            <button className="studio-icon-button" onClick={() => setRightOpen((open) => !open)} title="Toggle changes">
              {rightOpen ? <PanelRightClose /> : <FileDiff />}
            </button>
          </div>
        </header>

          {hasLiveSession ? (
            <WorkspaceSession
              workspaceId={workspace.id}
              local={isLocal}
              showTerminal={showTerminal}
              initialPrompt={initialPrompt}
              initialAttachmentIds={initialAttachmentIds}
            />
          ) : (
            <div className="studio-offline">
              <div className="studio-empty-chat">
                <div className="studio-empty-icon"><MessageSquarePlus /></div>
                <h3>{offline.title}</h3>
                <p>{offline.detail}</p>
              </div>
              <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder={offline.placeholder} />
            </div>
          )}
      </section>

      {rightOpen && (
        <aside className="studio-inspector">
          <div className="studio-inspector-tabs" aria-label="Workspace changes">
            <span className="studio-inspector-label"><FileDiff /> Changes</span>
            <button className="studio-close-inspector" onClick={() => setRightOpen(false)} title="Close inspector"><X /></button>
          </div>
          <div className="studio-inspector-content is-diff">
            <WorkspaceChanges
              workspaceId={workspace.id}
              local={isLocal}
              active={isReady}
              baseBranch={workspace.baseBranch}
            />
          </div>
        </aside>
      )}
    </div>
  );
}

/** Why there is no live session, in the words the empty chat shows. */
function offlineCopy({
  workspace,
  isReady,
}: {
  workspace: Workspace;
  isReady: boolean;
}): { title: string; detail: string; placeholder: string } {
  if (workspace.status === "failed") {
    return {
      title: "This workspace didn't start",
      detail: workspace.errorMessage ?? "Provisioning failed. Start a new session to try again.",
      placeholder: "Start a new session to try again",
    };
  }
  if (isReady) {
    return {
      title: "Live session unavailable",
      detail: "Live sessions require the Daytona Runtime provider.",
      placeholder: "Live sessions require the Daytona Runtime provider",
    };
  }
  return {
    title: "Live session unavailable",
    detail: "The workspace session will attach when provisioning completes.",
    placeholder: "The session will attach once the workspace is ready",
  };
}
