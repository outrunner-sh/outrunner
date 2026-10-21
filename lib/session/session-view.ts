import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";

/** What the app layout loaded for the sidebar, shared with the pages under it
 *  (components/app-data.tsx). */
export type AppData = {
  projects: NavProject[];
  workspaces: Workspace[];
  /** By workspace id. */
  pullRequests: Record<string, WorkspacePullRequest>;
};

/** What a cloud session's page needs to show it. */
export type SessionView = {
  workspace: Workspace;
  projectName?: string;
  pullRequest: WorkspacePullRequest | null;
};

/**
 * A cloud session's page from what the sidebar already holds, so it shows the
 * moment it is clicked; null when the sidebar doesn't have it (made since it
 * loaded, in another tab, or gone), and the server has to say. A deleted
 * session is gone even if a stale list still has it.
 */
export function resolveSessionView(id: string, data: AppData | null): SessionView | null {
  const workspace = data?.workspaces.find((w) => w.id === id);
  if (!data || !workspace || workspace.status === "destroyed") return null;
  return {
    workspace,
    projectName: data.projects.find((p) => p.id === workspace.projectId)?.fullName,
    pullRequest: data.pullRequests[workspace.id] ?? null,
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
