/**
 * The repositories a session's pull requests are in: its own, or, for a
 * session of several, each of its checkouts. Pure, so it's unit-tested.
 */
import type { Workspace } from "@/lib/runtime/types";

export type SessionRepo = {
  projectId: string;
  /** `owner/name`; null for a session of one, named by its project. */
  fullName: string | null;
  /** Its folder of the session's; null for a session of one. */
  checkout: string | null;
  baseBranch: string;
};

/** The session's repositories, in its order. */
export function sessionRepos(workspace: Pick<Workspace, "projectId" | "baseBranch" | "checkouts">): SessionRepo[] {
  if (!workspace.checkouts) {
    return [{ projectId: workspace.projectId, fullName: null, checkout: null, baseBranch: workspace.baseBranch }];
  }
  return workspace.checkouts.map((c) => ({
    projectId: c.projectId,
    fullName: c.fullName,
    checkout: c.checkout,
    baseBranch: c.baseBranch,
  }));
}

/** The repository `projectId` names, one of the session's; its own when
 *  none is named; null for one that isn't the session's. */
export function sessionRepo(
  workspace: Pick<Workspace, "projectId" | "baseBranch" | "checkouts">,
  projectId: string | null,
): SessionRepo | null {
  const repos = sessionRepos(workspace);
  if (projectId === null) return repos.find((r) => r.projectId === workspace.projectId) ?? repos[0];
  return repos.find((r) => r.projectId === projectId) ?? null;
}
