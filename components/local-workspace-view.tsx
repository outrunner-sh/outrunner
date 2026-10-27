"use client";

import { Laptop, RotateCw } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { RaillessSidebarButtons } from "@/components/app-frame";
import { RouteLoading } from "@/components/route-states";
import { ErrorRef, Notice } from "@/components/ui/notice";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { isAgentId } from "@/lib/agents/registry";
import { LOCAL_PROJECT, LOCAL_RUNNER_LOG, runnerDidNotStartDetail, type LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace } from "@/lib/runtime/types";

/**
 * A local session's page. Its record is on this Mac, not the server, so it is
 * looked up here — through the Outrunner app — and rendered in the same studio
 * as a cloud workspace. The list is the one the sidebar already read, so a
 * session it shows opens at once.
 */
export function LocalWorkspaceView() {
  const { id: workspaceId } = useParams<{ id: string }>();
  // The first prompt carried in from the new-session screen.
  const initialPrompt = useSearchParams().get("prompt") ?? undefined;
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
  // The runner is what failed, not the session being missing: say it the way
  // the session page does, with its log to quote and a way to try again. The
  // try is the one look the list shares, so while it is under way the button
  // says so instead of queueing another.
  if (local.state === "error" && (local.code === "agent-did-not-start" || local.code === "agent-spawn-failed")) {
    return (
      <Centered>
        <div className="w-full max-w-md text-left">
          <Notice
            tone="error"
            title="This Mac's session runner didn't start"
            detail={runnerDidNotStartDetail(local.reason)}
            meta={<ErrorRef label="log" value={LOCAL_RUNNER_LOG} />}
            actions={[
              {
                label: "Try again",
                icon: <RotateCw className={local.refreshing ? "is-working" : undefined} />,
                primary: true,
                disabled: local.refreshing,
                onClick: local.refresh,
              },
            ]}
          />
        </div>
        <Link href="/" className="text-sm underline underline-offset-4">
          Back home
        </Link>
      </Centered>
    );
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
    // Its agent on this Mac knows it (session.model); no row records it.
    model: null,
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
    environmentId: null,
    checkouts: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
}
