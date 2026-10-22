"use client";

import { MessageSquarePlus, PanelRight, PanelRightClose } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CollapsedSidebarButtons } from "@/components/app-frame";
import { SessionComposer } from "@/components/session-composer";
import { SessionDidntStart } from "@/components/session-didnt-start";
import { SetupStalled } from "@/components/setup-stalled";
import { Spinner } from "@/components/ui/loaders";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { WorkspaceEnvironment } from "@/components/workspace-environment";
import { type SessionSender, WorkspaceSession } from "@/components/workspace-session";
import { useQueuedFirstPrompt } from "@/hooks/use-queued-first-prompt";
import { useRestoreOnOpen } from "@/hooks/use-restore-on-open";
import { useWorkspaceSetup } from "@/hooks/use-workspace-setup";
import { localSessionLabel } from "@/lib/desktop/local-sessions";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import { workspaceLabel } from "@/lib/nav/session-title";
import { onRuntimeComputer, type Workspace, type WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** The session itself: a header across the top, then the chat, with its
 *  Environment (changes, branch, pull request) on the right. The app
 *  sidebar to its left belongs to the layout (app/(app)/layout.tsx); collapsed,
 *  its buttons sit at the start of this header. */
export function WorkspaceStudio({
  workspace,
  projectName,
  local,
  pullRequest,
  initialPrompt,
  initialAttachmentIds,
}: {
  workspace: Workspace;
  /** The repository's name, shown while a new cloud session's box is set up. */
  projectName?: string;
  /** Set for a local session, which runs on this Mac and is driven through the
   *  Outrunner app rather than the server. */
  local?: LocalSession;
  /** The session's pull request, shown in the Environment panel when there is one. */
  pullRequest: WorkspacePullRequest | null;
  /** First prompt carried in from the new-session screen, sent once connected. */
  initialPrompt?: string;
  /** Attachment ids staged on the home composer, sent with the first prompt. */
  initialAttachmentIds?: string[];
}) {
  const [rightOpen, setRightOpen] = useState(true);
  // How the Environment panel's Create PR sends into the session, while it can.
  const [sender, setSender] = useState<SessionSender | null>(null);
  const isLocal = local !== undefined;
  const { state: setup, phase, hasComputer, keepWaiting } = useWorkspaceSetup(workspace, !isLocal);
  // An archived session (one imported from a Mac) comes back as it opens.
  const restore = useRestoreOnOpen(workspace, !isLocal);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && (onRuntimeComputer(workspace.provider) || isLocal);
  const offline = offlineCopy({ workspace, isReady });
  const queued = useQueuedFirstPrompt(workspace.id, { prompt: initialPrompt ?? "", attachmentIds: initialAttachmentIds ?? [] });
  // Beside the title: the repository by its short name, or this Mac's folder.
  const place = local ? local.name : projectName?.split("/").pop();

  return (
    <div className={cn("studio-shell", !rightOpen && "no-inspector")}>
      <header className="studio-header">
        <div className="studio-title">
          <CollapsedSidebarButtons className="mr-1 flex shrink-0 items-center gap-0.5" />
          <span
            className={cn("studio-status", `is-${workspace.status}`)}
            title={workspace.status}
            aria-label={`Session ${workspace.status}`}
            role="img"
          />
          <h2>{local ? localSessionLabel(local) : workspaceLabel(workspace)}</h2>
          {place && <span className="studio-title-place">{place}</span>}
        </div>
        <div className="studio-header-actions">
          <button
            className="studio-icon-button"
            onClick={() => setRightOpen((open) => !open)}
            title={rightOpen ? "Hide environment" : "Show environment"}
            aria-pressed={rightOpen}
          >
            {rightOpen ? <PanelRightClose /> : <PanelRight />}
          </button>
        </div>
      </header>

      <section className="studio-chat">
        {hasLiveSession ? (
          <WorkspaceSession
            workspaceId={workspace.id}
            projectId={isLocal ? undefined : workspace.projectId}
            agent={workspace.agent}
            local={isLocal}
            untitled={!isLocal && !workspace.title}
            initialPrompt={initialPrompt}
            initialAttachmentIds={initialAttachmentIds}
            onSender={setSender}
          />
        ) : setup !== "ended" ? (
          <div className="studio-offline">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WorkspaceCreating
                projectName={projectName ?? workspaceLabel(workspace)}
                branch={workspace.baseBranch}
                startedAt={workspace.createdAt}
                phase={phase}
                hasExistingComputer={hasComputer}
                stalled={setup === "stalled" && <SetupStalled workspace={workspace} onKeepWaiting={keepWaiting} />}
                queued={queued}
              />
            </div>
            <SessionComposer
              onSend={() => {}}
              canSend={false}
              disabledPlaceholder={
                setup === "stalled"
                  ? "Start over to try again"
                  : queued
                    ? "Your message sends as soon as the session is ready"
                    : "Claude starts here, with your first message, once the session is ready"
              }
            />
          </div>
        ) : restore.state === "restoring" ? (
          <div className="studio-offline">
            <div className="studio-empty-chat" role="status">
              <div className="studio-empty-icon"><Spinner /></div>
              <h3>Restoring this session</h3>
              <p>
                Bringing back its conversation, commits and changes on a cloud computer. It takes a minute or two
                when the project&apos;s computer has to start.
              </p>
            </div>
            <SessionComposer
              onSend={() => {}}
              canSend={false}
              disabledPlaceholder="The session picks up where it left off once it's restored"
            />
          </div>
        ) : restore.state === "failed" ? (
          <div className="studio-offline">
            <div className="studio-empty-chat" role="alert">
              <div className="studio-empty-icon"><MessageSquarePlus /></div>
              <h3>This session didn&apos;t restore</h3>
              <p>{restore.error}</p>
              <p className="flex justify-center gap-4">
                {restore.settingsHref && (
                  <Link href={restore.settingsHref} className="text-(--studio-text) underline underline-offset-4">
                    Open settings
                  </Link>
                )}
                {restore.retry && (
                  <button type="button" onClick={restore.retry} className="text-(--studio-text) underline underline-offset-4">
                    Try again
                  </button>
                )}
              </p>
            </div>
            <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder="Restore the session to continue it" />
          </div>
        ) : workspace.status === "failed" && !isLocal ? (
          <div className="studio-offline">
            <SessionDidntStart
              workspace={workspace}
              detail={workspace.errorMessage ?? "Its box couldn't be set up. Nothing was lost; try again to start a fresh one."}
            />
            <SessionComposer onSend={() => {}} canSend={false} disabledPlaceholder="Try again to start a fresh session" />
          </div>
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

      {/* The rows poll for changes, so they mount only while it is open. */}
      <aside className="studio-inspector studio-env" hidden={!rightOpen} aria-label="Environment">
        {rightOpen && (
          <WorkspaceEnvironment
            workspace={workspace}
            local={local}
            pullRequest={pullRequest}
            isReady={isReady}
            sender={sender}
            onClose={() => setRightOpen(false)}
          />
        )}
      </aside>
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
  // A cloud one gets SessionDidntStart instead; this is a local one's.
  if (workspace.status === "failed") {
    return {
      title: "This session didn't start",
      detail: workspace.errorMessage ?? "Its setup stopped before it finished. Start a new session to try again.",
      placeholder: "Start a new session to try again",
    };
  }
  if (workspace.status === "archived") {
    // Restored as it opens (useRestoreOnOpen) on a Runtime Computer; this is
    // one on a sandbox that can't.
    return {
      title: "Session archived",
      detail: "Restoring it needs a cloud computer, which this session's sandbox is not.",
      placeholder: "Archived sessions restore on a cloud computer",
    };
  }
  if (isReady) {
    return {
      title: "Live session unavailable",
      detail: "Live sessions need a cloud sandbox provider, which this server is not using.",
      placeholder: "Live sessions need a cloud sandbox provider",
    };
  }
  return {
    title: "Live session unavailable",
    detail: "The workspace session will attach when provisioning completes.",
    placeholder: "The session will attach once the workspace is ready",
  };
}
