import { localSessionLabel } from "@/lib/desktop/local-sessions";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import { workspaceLabel } from "@/lib/nav/session-title";
import { newestFirst, recency, type NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";

export const RECENT_SESSION_LIMIT = 5;

export type RecentSession = {
  id: string;
  href: string;
  title: string;
  project: string;
  at: string;
  local: boolean;
};

/** Home's resumable sessions, including Runners, but not their child Ships. */
export function recentSessions(
  workspaces: readonly Workspace[],
  local: readonly LocalSession[],
  projects: readonly NavProject[],
): RecentSession[] {
  const names = new Map(projects.map((project) => [project.id, project.fullName]));
  const cloud = workspaces
    .filter((workspace) => !workspace.parentMissionId && !["archived", "archiving", "destroyed"].includes(workspace.status))
    .map((workspace): RecentSession => ({
      id: workspace.id,
      href: `/workspaces/${workspace.id}`,
      title: workspaceLabel(workspace),
      project: names.get(workspace.projectId) ?? "Repository",
      at: activity(recency(workspace), workspace.createdAt),
      local: false,
    }));
  const mac = local.map((session): RecentSession => ({
    id: session.workspaceId,
    href: `/local/${session.workspaceId}`,
    title: localSessionLabel(session),
    project: session.name,
    at: activity(session.lastActiveAt, session.createdAt),
    local: true,
  }));
  const seen = new Set<string>();
  return [...cloud, ...mac]
    .sort((a, b) => newestFirst(a.at, b.at) || a.href.localeCompare(b.href))
    .filter((session) => {
      if (seen.has(session.href)) return false;
      seen.add(session.href);
      return true;
    })
    .slice(0, RECENT_SESSION_LIMIT);
}

function activity(last: string | undefined, created: string): string {
  return last && Number.isFinite(Date.parse(last)) ? last : created;
}

/** Calendar days in the viewer's timezone, including days changed by DST. */
export function recentSessionGroups(sessions: readonly RecentSession[], now: number): Array<{ label: string; sessions: RecentSession[] }> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, RecentSession[]>();
  for (const session of sessions) {
    const at = Date.parse(session.at);
    const label = at >= today.getTime() ? "Today" : at >= yesterday.getTime() ? "Yesterday" : "Earlier";
    const group = groups.get(label);
    if (group) group.push(session);
    else groups.set(label, [session]);
  }
  return [...groups].map(([label, sessions]) => ({ label, sessions }));
}
