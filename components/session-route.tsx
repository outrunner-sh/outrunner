"use client";

import { useParams, useSearchParams } from "next/navigation";
import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";

import { useAppData } from "@/components/app-data";
import { RouteLoading } from "@/components/route-states";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { newerSessionView, resolveSessionView, type SessionView } from "@/lib/session/session-view";

/** Where the server's answer about the session lands (ServerSessionView). */
const ServerViewContext = createContext<(view: SessionView) => void>(() => {});

/**
 * A cloud session's page. It shows at once from what the sidebar holds
 * (lib/session/session-view.ts); the server's own read (`server`, streamed in
 * under Suspense) stands in for a session the sidebar doesn't have yet — one
 * just made — and is where a session that is gone turns into not-found.
 *
 * The studio sits in one place whichever answer it shows, so the sidebar
 * catching up on a new session (router.refresh) doesn't remount it mid-setup.
 * With both, the newer row shows.
 */
export function SessionRoute({ server }: { server: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const fromSidebar = resolveSessionView(id, useAppData());
  const [fromServer, setFromServer] = useState<SessionView | null>(null);
  const view = newerSessionView(id, fromSidebar, fromServer);

  // The first prompt carried in from the new-session screen. Repeated
  // ?attachment= params are each an id.
  const search = useSearchParams();
  const initialPrompt = search.get("prompt") ?? undefined;
  const attachments = search.getAll("attachment").join("\n");
  const initialAttachmentIds = useMemo(() => (attachments ? attachments.split("\n") : []), [attachments]);

  return (
    <>
      {view ? (
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
      <ServerViewContext.Provider value={setFromServer}>{server}</ServerViewContext.Provider>
    </>
  );
}

/** The server's read of the session, handed to the {@link SessionRoute} it is
 *  rendered in. Shows nothing itself. */
export function ServerSessionView({ view }: { view: SessionView }) {
  const set = useContext(ServerViewContext);
  useLayoutEffect(() => set(view), [set, view]);
  return null;
}
