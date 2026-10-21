import { markProjectsAccessLost, upsertProjects } from "@/lib/db/repositories";
import type { GitHubRepositoryList } from "@/lib/github/client";
import { planProjectReconcile } from "@/lib/github/reconcile";
import type { Project } from "@/lib/runtime/types";

/**
 * Bring the user's connected projects up to date with a listing of their
 * GitHub repositories (see {@link planProjectReconcile}): writes only what
 * changed, so a listing that changed nothing writes nothing.
 *
 * `ownerId` must come from the verified session.
 */
export async function reconcileProjects(
  ownerId: string,
  projects: readonly Project[],
  list: GitHubRepositoryList,
): Promise<void> {
  const plan = planProjectReconcile(projects, list);
  await Promise.all([upsertProjects(ownerId, plan.refresh), markProjectsAccessLost(plan.lost)]);
}
