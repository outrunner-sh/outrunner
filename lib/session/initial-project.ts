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

/** Where the new-session form starts: one of the listed environments
 *  (lib/environments/listed.ts), or a repository, from its own environment. */
export type StartOn = { environmentId: string; projectId?: undefined } | { projectId: string; environmentId?: undefined };

/**
 * Where home (and a bare /new) starts the next session, in this order: where
 * a session was just refused, while the screen still says why (its reason is
 * said only there); the org's default environment; the most recent
 * session's environment when it's listed, else its repository; the first
 * environment. Each only while it's listed: never one nobody can pick.
 * Undefined, with none of those, leaves the form on its first repository
 * (initialProjectId), so home always offers one.
 *
 * The most recent session is ranked by `lastActiveAt ?? createdAt` (the
 * sidebar's rule), so a brand-new session still provisioning counts.
 */
export function homeStart(
  environments: readonly { id: string; orgDefault: boolean }[],
  projects: readonly { id: string }[],
  workspaces: readonly Pick<Workspace, "projectId" | "environmentId" | "lastActiveAt" | "createdAt">[],
  refused?: { projectId: string; environmentId?: string | null } | null,
): StartOn | undefined {
  const listedEnvironment = (id: string | null | undefined): id is string => !!id && environments.some((e) => e.id === id);
  const listedProject = (id: string) => projects.some((p) => p.id === id);
  if (refused) {
    if (listedEnvironment(refused.environmentId)) return { environmentId: refused.environmentId };
    if (listedProject(refused.projectId)) return { projectId: refused.projectId };
  }
  const orgDefault = environments.find((e) => e.orgDefault);
  if (orgDefault) return { environmentId: orgDefault.id };
  if (workspaces.length > 0) {
    const recent = workspaces.reduce((a, b) => (newestFirst(recency(a), recency(b)) > 0 ? b : a));
    if (listedEnvironment(recent.environmentId)) return { environmentId: recent.environmentId };
    if (listedProject(recent.projectId)) return { projectId: recent.projectId };
  }
  return environments[0] ? { environmentId: environments[0].id } : undefined;
}
