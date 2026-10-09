import { newestFirst, recency } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";

/**
 * Which repository the new-session form starts on. With none requested, the
 * first listed. With one requested, that one if it is listed, and otherwise
 * none ("") so the user has to pick: a session must never be created in a
 * repository nobody chose (a deleted one, or one the list leaves out).
 */
export function initialProjectId(projects: { id: string }[], requested?: string): string {
  if (requested === undefined) return projects[0]?.id ?? "";
  return projects.some((p) => p.id === requested) ? requested : "";
}

/**
 * The repository home starts the next session on: the most recent session's.
 * Ranked by `lastActiveAt ?? createdAt` (the sidebar's rule), so a brand-new
 * session still provisioning counts. Undefined (the form's first repository)
 * when there is no session yet, or its repository is no longer listed: home
 * must offer a repository either way, never leave the user to pick one.
 */
export function lastSessionProjectId(
  projects: { id: string }[],
  workspaces: Pick<Workspace, "projectId" | "lastActiveAt" | "createdAt">[],
): string | undefined {
  if (workspaces.length === 0) return undefined;
  const recent = workspaces.reduce((a, b) => (newestFirst(recency(a), recency(b)) > 0 ? b : a));
  return projects.some((p) => p.id === recent.projectId) ? recent.projectId : undefined;
}
