"use client";

import { MessageSquarePlus, PanelRight, PanelRightClose, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { SessionComposer } from "@/components/session-composer";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { WorkspaceEnvironment } from "@/components/workspace-environment";
import { type SessionSender, WorkspaceSession } from "@/components/workspace-session";
import { useWorkspaceSetup } from "@/hooks/use-workspace-setup";
import { localSessionLabel } from "@/lib/desktop/local-sessions";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import { workspaceLabel } from "@/lib/nav/session-title";
import { onRuntimeComputer, type Workspace, type WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** The session itself: chat in the middle, its Environment (changes, branch,
 *  pull request, terminal) on the right. The app sidebar to its left belongs
 *  to the layout (app/(app)/layout.tsx). */
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
  // The live terminal is tucked away by default; it is where Claude's own
  // prompts are answered — in a local session, every shell-command approval.
  // (Collapsed also keeps its socket closed: see useSessionTerminal.)
  const [showTerminal, setShowTerminal] = useState(false);
  // The bottom of the Environment panel, where the session docks its terminal.
  const [terminalSlot, setTerminalSlot] = useState<HTMLDivElement | null>(null);
  // How the Environment panel's Create PR sends into the session, while it can.
  const [sender, setSender] = useState<SessionSender | null>(null);
  // The header's terminal button shows it even with the panel closed.
  const toggleTerminalFromHeader = () => {
    if (showTerminal && rightOpen) {
      setShowTerminal(false);
    } else {
      setRightOpen(true);
      setShowTerminal(true);
    }
  };
  const isLocal = local !== undefined;
  const setup = useWorkspaceSetup(workspace, !isLocal);
  const isReady = workspace.status === "ready" || workspace.status === "idle";
  const hasLiveSession = isReady && (onRuntimeComputer(workspace.provider) || isLocal);
  const offline = offlineCopy({ workspace, isReady, stalled: setup === "stalled" });

  return (
    <div className={cn("studio-shell", !rightOpen && "no-inspector")}>
      <section className="studio-chat">
        <header className="studio-chat-header">
          <div className="studio-title">
            <span
              className={cn("studio-status", `is-${workspace.status}`)}
              title={workspace.status}
              aria-label={`Session ${workspace.status}`}
              role="img"
            />
            <h2>{local ? localSessionLabel(local) : workspaceLabel(workspace)}</h2>
          </div>
          <div className="studio-header-actions">
            {hasLiveSession && (
              <button
                className={cn("studio-icon-button", showTerminal && rightOpen && "is-active")}
                onClick={toggleTerminalFromHeader}
                title={showTerminal && rightOpen ? "Hide terminal" : "Show terminal"}
                aria-pressed={showTerminal && rightOpen}
              >
                <TerminalSquare />
              </button>
            )}
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

          {hasLiveSession ? (
            <WorkspaceSession
              workspaceId={workspace.id}
              agent={workspace.agent}
              local={isLocal}
              showTerminal={showTerminal}
              onToggleTerminal={() => setShowTerminal((open) => !open)}
              terminalSlot={terminalSlot}
              untitled={!isLocal && !workspace.title}
              initialPrompt={initialPrompt}
              initialAttachmentIds={initialAttachmentIds}
              onSender={setSender}
            />
          ) : setup === "running" ? (
            <div className="studio-offline">
              <div className="min-h-0 flex-1 overflow-y-auto">
                <WorkspaceCreating
                  projectName={projectName ?? workspaceLabel(workspace)}
                  branch={workspace.baseBranch}
                  startedAt={workspace.createdAt}
                />
              </div>
              <SessionComposer
                onSend={() => {}}
                canSend={false}
                disabledPlaceholder="Claude starts here, with your first message, once the session is ready"
              />
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

      {/* Hidden rather than unmounted when closed: the terminal docked at its
          foot keeps its scrollback. The rows above poll for changes, so they
          mount only while it is open. */}
      <aside className="studio-inspector studio-env" hidden={!rightOpen} aria-label="Environment">
        {rightOpen && (
          <WorkspaceEnvironment
            workspace={workspace}
            local={local}
            pullRequest={pullRequest}
            isReady={isReady}
            sender={sender}
            terminalOpen={hasLiveSession && showTerminal}
            onClose={() => setRightOpen(false)}
          />
        )}
        <div ref={setTerminalSlot} className="studio-env-terminal-slot" />
      </aside>
    </div>
  );
}

/** Why there is no live session, in the words the empty chat shows. */
function offlineCopy({
  workspace,
  isReady,
  stalled,
}: {
  workspace: Workspace;
  isReady: boolean;
  /** Set up for so long it never will (lib/session/provisioning.ts). */
  stalled: boolean;
}): { title: string; detail: string; placeholder: string } {
  if (stalled) {
    return {
      title: "This workspace didn't start",
      detail: "Its setup stopped before it finished. Delete it and start a new session to try again.",
      placeholder: "Start a new session to try again",
    };
  }
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
