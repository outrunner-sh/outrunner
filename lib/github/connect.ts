/**
 * Turning GitHub repositories into projects, by id (the picker) or by
 * `owner/name` (a local checkout's remote, on import). Each is looked up with
 * the user's token rather than trusting what was posted: a repository the
 * token cannot see must not become a project row.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
import type { GitHubRepository } from "@/lib/github/client";

/** Lookups of repositories run at once. */
const LOOKUP_CONCURRENCY = 6;

export type ConnectDeps = {
  /** GitHub's record of a repository, or null when the token can't see it. */
  lookup(token: string, ref: number | string): Promise<GitHubRepository | null>;
  /** Saves repositories as the owner's projects; returns how many. */
  upsert(ownerId: string, repositories: GitHubRepository[]): Promise<number>;
};

export type ConnectResult = {
  /** The repositories the token can see, now projects, in the order asked. */
  repositories: GitHubRepository[];
  /** Project rows written. */
  synced: number;
};

export async function connectRepositories(
  ownerId: string,
  token: string,
  refs: ReadonlyArray<number | string>,
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const found = await mapWithConcurrency(refs, LOOKUP_CONCURRENCY, (ref) => deps.lookup(token, ref));
  const repositories = found.filter((repo): repo is GitHubRepository => repo !== null);
  const synced = repositories.length > 0 ? await deps.upsert(ownerId, repositories) : 0;
  return { repositories, synced };
}
