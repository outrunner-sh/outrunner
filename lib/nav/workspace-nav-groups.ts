import type { Project, Workspace } from "@/lib/runtime/types";

/** The only project fields the nav renders — lets us synthesize a placeholder. */
export type NavProject = Pick<Project, "id" | "name" | "fullName">;

export type NavGroup = { project: NavProject; items: Workspace[] };

/** Stand-in group header for a workspace whose project isn't in the list. */
export function fallbackProject(id: string): NavProject {
  return { id, name: "Repository", fullName: "Repository" };
}

/** A workspace's recency key: its last-active time, or its creation time when it
 *  has never been touched (a still-provisioning workspace has a null
 *  lastActiveAt). Exported so home's default repository ranks by the same rule
 *  as the sidebar: a brand-new workspace must be considered most-recent. */
export const recency = (w?: Pick<Workspace, "lastActiveAt" | "createdAt">) => w?.lastActiveAt ?? w?.createdAt ?? "";

/**
 * Comparator for timestamps, newest first. By instant, not by text: the times
 * come from Postgres (`…00.123456+00:00`, fraction digits trimmed) and from the
 * Mac's agent (`…00Z`), and as strings `12:00:00Z` sorts after
 * `12:00:00.001Z`. A missing or unparseable time sorts last.
 */
export function newestFirst(a: string | null | undefined, b: string | null | undefined): number {
  const [ta, tb] = [instant(a), instant(b)];
  return ta === tb ? 0 : tb > ta ? 1 : -1;
}

function instant(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Group workspaces under their project for the studio nav, each group's items
 * most-recent-first and groups ordered by their most-recent workspace.
 *
 * Driven off the workspaces, not the project list: a workspace under a hidden
 * (or otherwise unlisted) project is still openable, so it must never vanish
 * from the nav. Its group falls back to a placeholder header instead.
 */
export function buildNavGroups(
  projects: NavProject[],
  workspaces: Workspace[],
): NavGroup[] {
  const byProject = new Map<string, Workspace[]>();
  for (const w of workspaces) {
    const list = byProject.get(w.projectId) ?? [];
    list.push(w);
    byProject.set(w.projectId, list);
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return [...byProject.entries()]
    .map(([projectId, items]) => ({
      project: projectById.get(projectId) ?? fallbackProject(projectId),
      items: items.slice().sort((a, b) => newestFirst(recency(a), recency(b))),
    }))
    .sort((a, b) => newestFirst(recency(a.items[0]), recency(b.items[0])));
}

/**
 * Projects to offer when picking one, the likeliest first: `current` (the
 * open session's), then by their most recent session, then the rest in the
 * order given. Every project once; a session under an unlisted project adds
 * nothing.
 */
export function recentProjects<P extends NavProject>(
  projects: P[],
  workspaces: Pick<Workspace, "projectId" | "lastActiveAt" | "createdAt">[],
  current?: string | null,
): P[] {
  const latest = new Map<string, string>();
  for (const w of workspaces) {
    const at = recency(w);
    const seen = latest.get(w.projectId);
    if (seen === undefined || newestFirst(seen, at) > 0) latest.set(w.projectId, at);
  }
  const rank = (p: P) => (p.id === current ? 0 : latest.has(p.id) ? 1 : 2);
  return projects
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        rank(a.p) - rank(b.p) ||
        (rank(a.p) === 1 ? newestFirst(latest.get(a.p.id), latest.get(b.p.id)) : 0) ||
        a.i - b.i,
    )
    .map(({ p }) => p);
}
