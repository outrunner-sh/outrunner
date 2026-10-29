import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import type { SessionStanding } from "@/lib/session/standing";

/** What the app layout loaded for the sidebar, shared with the pages under it
 *  (components/app-data.tsx). */
export type AppData = {
  /** The repositories listed to start sessions in. */
  projects: Project[];
  /** Hidden ones a session belongs to, only for naming it. */
  hiddenProjects: Project[];
  workspaces: Workspace[];
  /** By workspace id. */
  pullRequests: Record<string, WorkspacePullRequest>;
  /** Where each session stands, by workspace id (lib/session/standing.ts);
   *  absent where it wasn't read. */
  standings?: Record<string, SessionStanding>;
};

/** What a cloud session's page needs to show it. */
export type SessionView = {
  workspace: Workspace;
  projectName?: string;
  pullRequest: WorkspacePullRequest | null;
};

/** The server's read of a cloud session's page: the session, that it was
 *  deleted (its row stays, marked destroyed) and what of it is left, or that
 *  there is no such session — yet, for one this tab has just started, whose
 *  page opens before the server has made it (lib/session/pending-sessions.ts). */
export type SessionAnswer =
  | SessionView
  | { gone: Pick<SessionView, "workspace" | "pullRequest"> & { pullRequests?: WorkspacePullRequest[] } }
  | { missing: true };

/**
 * A cloud session's page from what the sidebar already holds, so it shows the
 * moment it is clicked; null when the sidebar doesn't have it (made since it
 * loaded, in another tab, or gone), and the server has to say. A deleted
 * session is gone even if a stale list still has it.
 */
export function resolveSessionView(id: string, data: AppData | null): SessionView | null {
  const workspace = data?.workspaces.find((w) => w.id === id);
  if (!data || !workspace || workspace.status === "destroyed") return null;
  return sessionViewOf(workspace, data);
}

/**
 * A session's page from its row, whatever that row came from: the sidebar's
 * list, the server's read, or the one its creation answered with
 * (lib/session/pending-sessions.ts), which is the only one of the three that
 * arrives before the session's page is opened. The repository's name and the
 * session's pull request come from the sidebar's data, so both are missing
 * from a row the sidebar doesn't have yet.
 */
export function sessionViewOf(workspace: Workspace, data: AppData | null): SessionView {
  return {
    workspace,
    projectName: [...(data?.projects ?? []), ...(data?.hiddenProjects ?? [])].find(
      (p) => p.id === workspace.projectId,
    )?.fullName,
    pullRequest: data?.pullRequests[workspace.id] ?? null,
  };
}

/**
 * Of the sidebar's view of a session and the server's read of it, the one to
 * show: the newer row (the sidebar's may be from before the session last
 * changed; the server's from before a router.refresh), the sidebar's on a tie.
 * Either may be missing; a server read of another session doesn't count.
 */
export function newerSessionView(
  id: string,
  fromSidebar: SessionView | null,
  fromServer: SessionView | null,
): SessionView | null {
  const server = fromServer?.workspace.id === id ? fromServer : null;
  if (!fromSidebar || !server) return fromSidebar ?? server;
  return Date.parse(server.workspace.updatedAt) > Date.parse(fromSidebar.workspace.updatedAt) ? server : fromSidebar;
}

/** One pull request a session for the sidebar: its own repository's, else
 *  (a session of several that opened one elsewhere first) its oldest. The
 *  session's page reads each repository's itself. */
export function sessionPullRequests(
  workspaces: Workspace[],
  pullRequests: WorkspacePullRequest[],
): Record<string, WorkspacePullRequest> {
  const own = new Map(workspaces.map((w) => [w.id, w.projectId]));
  const picked: Record<string, WorkspacePullRequest> = {};
  for (const pr of pullRequests) {
    const current = picked[pr.workspaceId];
    if (!current || (current.projectId !== own.get(pr.workspaceId) && pr.projectId === own.get(pr.workspaceId))) {
      picked[pr.workspaceId] = pr;
    }
  }
  return picked;
}
