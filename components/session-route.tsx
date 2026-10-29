"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useAppData } from "@/components/app-data";
import { RouteMessage, SessionLoading } from "@/components/route-states";
import { useServerAnswer } from "@/components/server-answer";
import { SessionDeleted } from "@/components/session-deleted";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { replaceAddressBar } from "@/lib/client/address-bar";
import { useDeletedSession } from "@/lib/session/delete-session";
import { keepFirstPromptFromUrl, tabStorage } from "@/lib/session/first-prompt";
import { forgetPendingSession, usePendingSession } from "@/lib/session/pending-sessions";
import { newerSessionView, resolveSessionView, sessionViewOf, type SessionAnswer } from "@/lib/session/session-view";

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
  const data = useAppData();
  const listed = resolveSessionView(id, data);
  const sidebarHasIt = listed !== null;
  // This tab started it and the sidebar's data doesn't list it yet: its own
  // page opens on the row the create call answered with, rather than waiting
  // for the server to say what the page already knows.
  const pending = usePendingSession(id);
  const fromSidebar = listed ?? (pending ? sessionViewOf(pending.workspace, data) : null);
  const [answer, slot] = useServerAnswer<SessionAnswer>(server);
  const gone = answer && "gone" in answer ? answer.gone : null;
  // No such session, unless this tab is starting it: the server's read may
  // have come before its row was made.
  const missing = answer !== null && "missing" in answer && !pending && !sidebarHasIt;
  const view = newerSessionView(id, fromSidebar, answer && "workspace" in answer ? answer : null);
  // Deleted from the sidebar while this page was kept for going back to.
  const deleted = useDeletedSession(id);

  // The first prompt carried in from the new-session screen. Repeated
  // ?attachment= params are each an id.
  const search = useSearchParams();
  const initialPrompt = search.get("prompt") ?? undefined;
  const initialPromptKey = search.get("promptKey") ?? undefined;
  const attachments = search.getAll("attachment").join("\n");
  const initialAttachmentIds = useMemo(() => (attachments ? attachments.split("\n") : []), [attachments]);
  // The sidebar's data has the session now (the layout was re-read after the
  // create call): the row held from that call is done with.
  useEffect(() => {
    if (sidebarHasIt) forgetPendingSession(id);
  }, [sidebarHasIt, id]);

  // Out of the URL as soon as this tab keeps a copy, before it is sent: a
  // reload then sends it from the copy if it hasn't gone yet, and never again
  // once it has. The page reads it from the copy from here on.
  useEffect(() => {
    const next = keepFirstPromptFromUrl(tabStorage(), id, new URL(window.location.href));
    if (next) replaceAddressBar(next);
  }, [id, initialPrompt, attachments]);

  return (
    <>
      {deleted ? (
        <RouteMessage title="Session deleted" detail="This session and its worktree are gone." />
      ) : pending?.refused ? (
        // Started here and refused by the server: this page gives way to the
        // new-session screen, which says the same and gives the prompt back.
        <RouteMessage
          title="Couldn't start the session"
          detail={pending.refused}
          actions={[{ label: "Back to New Session", href: "/new", primary: true }]}
        />
      ) : missing ? (
        // As app/(app)/not-found.tsx says it.
        <RouteMessage
          title="Nothing at this link"
          detail="It may be out of date, or belong to another account."
          actions={[{ label: "Back to sessions", href: "/", primary: true }]}
        />
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
        <SessionLoading />
      )}
      {slot}
    </>
  );
}
