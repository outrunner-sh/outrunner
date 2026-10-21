"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { useAppData } from "@/components/app-data";
import { RouteLoading, RouteMessage } from "@/components/route-states";
import { useServerAnswer } from "@/components/server-answer";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { useDeletedSession } from "@/lib/session/delete-session";
import { newerSessionView, resolveSessionView, type SessionView } from "@/lib/session/session-view";

/**
 * A cloud session's page. It shows at once from what the sidebar holds
 * (lib/session/session-view.ts); the server's own read (`server`, streamed in
 * under Suspense, answering a SessionView) stands in for a session the sidebar
 * doesn't have yet — one just made — and is where a session that is gone turns
 * into not-found.
 *
 * The studio sits in one place whichever answer it shows, so the sidebar
 * catching up on a new session (router.refresh) doesn't remount it mid-setup.
 * With both, the newer row shows.
 */
export function SessionRoute({ server }: { server: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const fromSidebar = resolveSessionView(id, useAppData());
  const [fromServer, slot] = useServerAnswer<SessionView>(server);
  const view = newerSessionView(id, fromSidebar, fromServer);
  // Deleted from the sidebar while this page was kept for going back to.
  const deleted = useDeletedSession(id);

  // The first prompt carried in from the new-session screen. Repeated
  // ?attachment= params are each an id.
  const search = useSearchParams();
  const initialPrompt = search.get("prompt") ?? undefined;
  const attachments = search.getAll("attachment").join("\n");
  const initialAttachmentIds = useMemo(() => (attachments ? attachments.split("\n") : []), [attachments]);

  return (
    <>
      {deleted ? (
        <RouteMessage title="Session deleted" detail="This session and its worktree are gone." />
      ) : view ? (
        <WorkspaceStudio
          workspace={view.workspace}
          projectName={view.projectName}
          pullRequest={view.pullRequest}
          initialPrompt={initialPrompt}
          initialAttachmentIds={initialAttachmentIds}
        />
      ) : (
        <RouteLoading label="Opening session" />
      )}
      {slot}
    </>
  );
}
