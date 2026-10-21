"use client";

import { Laptop } from "lucide-react";
import Link from "next/link";

import { RaillessSidebarButtons } from "@/components/app-frame";
import { RouteLoading } from "@/components/route-states";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { isAgentId } from "@/lib/agents/registry";
import { LOCAL_PROJECT, type LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace } from "@/lib/runtime/types";

/**
 * A local session's page. Its record is on this Mac, not the server, so it is
 * looked up here — through the Outrunner app — and rendered in the same studio
 * as a cloud workspace.
 */
export function LocalWorkspaceView({
  workspaceId,
  initialPrompt,
}: {
  workspaceId: string;
  initialPrompt?: string;
}) {
  const local = useLocalSessions();
  const session = local.sessions.find((s) => s.workspaceId === workspaceId);

  if (session) {
    return (
      <WorkspaceStudio
        workspace={asWorkspace(session)}
        local={session}
        pullRequest={null}
        initialPrompt={initialPrompt}
      />
    );
  }
  if (local.state === "loading") {
    return <RouteLoading label="Looking for this session on your Mac" />;
  }
  return (
    <Centered>
      <Laptop className="size-6 text-muted-foreground" />
      <h1 className="text-lg font-medium">
        {local.state === "unavailable" ? "This session runs on a Mac" : "Session not found on this Mac"}
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        {local.state === "unavailable"
          ? "Local sessions live on the Mac that runs them. Open this one in the Outrunner app there."
          : local.state === "error"
            ? local.message
            : "It may have been deleted, or it was started on a different Mac."}
      </p>
      <Link href="/" className="text-sm underline underline-offset-4">
        Back home
      </Link>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <RaillessSidebarButtons />
      {children}
    </div>
  );
}

/** The studio speaks Workspace; a local session fills in the parts it uses. */
function asWorkspace(session: LocalSession): Workspace {
  return {
    id: session.workspaceId,
    projectId: LOCAL_PROJECT,
    // Not a row of anyone's: it lives on this Mac, outside the database.
    ownerId: "",
    provider: "local",
    agent: isAgentId(session.agent) ? session.agent : "claude",
    // A local session is always openable: attaching starts (or continues) it.
    status: "ready",
    phase: "claude_ready",
    branch: session.branch,
    title: session.title || null,
    baseBranch: session.baseBranch,
    worktreePath: session.worktree,
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: `ws-${session.workspaceId}`,
    agentWorkspaceId: session.workspaceId,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
}
