"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useAppData } from "@/components/app-data";
import { RouteLoading, RouteMessage } from "@/components/route-states";
import { useServerAnswer } from "@/components/server-answer";
import { SessionDeleted } from "@/components/session-deleted";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { useDeletedSession } from "@/lib/session/delete-session";
import { keepFirstPromptFromUrl, tabStorage } from "@/lib/session/first-prompt";
import { newerSessionView, resolveSessionView, type SessionAnswer } from "@/lib/session/session-view";

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
  const [answer, slot] = useServerAnswer<SessionAnswer>(server);
  const gone = answer && "gone" in answer ? answer.gone : null;
  const view = newerSessionView(id, fromSidebar, answer && !("gone" in answer) ? answer : null);
  // Deleted from the sidebar while this page was kept for going back to.
  const deleted = useDeletedSession(id);

  // The first prompt carried in from the new-session screen. Repeated
  // ?attachment= params are each an id.
  const search = useSearchParams();
  const initialPrompt = search.get("prompt") ?? undefined;
  const initialPromptKey = search.get("promptKey") ?? undefined;
  const attachments = search.getAll("attachment").join("\n");
  const initialAttachmentIds = useMemo(() => (attachments ? attachments.split("\n") : []), [attachments]);
  // Out of the URL as soon as this tab keeps a copy, before it is sent: a
  // reload then sends it from the copy if it hasn't gone yet, and never again
  // once it has. The page reads it from the copy from here on. (State null:
  // see dropFirstPromptFromAddressBar.)
  useEffect(() => {
    const next = keepFirstPromptFromUrl(tabStorage(), id, new URL(window.location.href));
    if (next) window.history.replaceState(null, "", next);
  }, [id, initialPrompt, attachments]);

  return (
    <>
      {deleted ? (
        <RouteMessage title="Session deleted" detail="This session and its worktree are gone." />
      ) : gone ? (
        // Ahead of a sidebar list from before the delete.
        <SessionDeleted workspace={gone.workspace} pullRequest={gone.pullRequest} pullRequests={gone.pullRequests} />
      ) : view ? (
        <WorkspaceStudio
          workspace={view.workspace}
          projectName={view.projectName}
          pullRequest={view.pullRequest}
          initialPrompt={initialPrompt}
          initialPromptKey={initialPromptKey}
          initialAttachmentIds={initialAttachmentIds}
        />
      ) : (
        <RouteLoading label="Opening session" />
      )}
      {slot}
    </>
  );
}
