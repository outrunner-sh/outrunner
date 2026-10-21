import { mapWithConcurrency } from "@/lib/concurrency";
import { markProjectsAccessLost, upsertProjects } from "@/lib/db/repositories";
import { getGitHubRepository, type GitHubRepositoryList } from "@/lib/github/client";
import { lookupWindow, planProjectReconcile, settleMissing } from "@/lib/github/reconcile";
import type { Project } from "@/lib/runtime/types";

/** Missing projects looked up per reconcile; any beyond wait for the next. */
const MAX_MISSING_LOOKUPS = 20;
const LOOKUP_CONCURRENCY = 6;

/** Where each user's next window of lookups starts (lookupWindow). Per
 *  process, like the listing cache: a restart only starts the round again. */
const lookupCursors = new Map<string, number>();

/**
 * Bring the user's connected projects up to date with a listing of their
 * GitHub repositories, read with `token` (see {@link planProjectReconcile}):
 * writes only what changed, so a listing that changed nothing writes nothing.
 *
 * A project the listing is missing is looked up on its own first, and marked
 * lost only if GitHub says the user can't see it (a public repository outside
 * the listing's affiliations is still theirs to use).
 *
 * `ownerId` must come from the verified session, and `list` must have been
 * read from GitHub for this call, not reused: an older listing would write
 * older details over a repository connected since.
 */
export async function reconcileProjects(
  ownerId: string,
  token: string,
  projects: readonly Project[],
  list: GitHubRepositoryList,
): Promise<void> {
  const plan = planProjectReconcile(projects, list);

  const batch = lookupWindow(plan.missing, lookupCursors.get(ownerId) ?? 0, MAX_MISSING_LOOKUPS);
  lookupCursors.set(ownerId, batch.nextCursor);
  const found = await mapWithConcurrency(batch.ids, LOOKUP_CONCURRENCY, (id) =>
    // One failed lookup (a rate limit) leaves that project for next time.
    getGitHubRepository(token, id).catch((error: unknown) => {
      console.error("Could not look up a missing project's repository", { id, error });
      return undefined;
    }),
  );
  const settled = settleMissing(projects, batch.ids, found);

  // Already-lost ones are marked again harmlessly: the first time stays.
  await Promise.all([
    upsertProjects(ownerId, [...plan.refresh, ...settled.refresh]),
    markProjectsAccessLost(settled.lost),
  ]);
}
