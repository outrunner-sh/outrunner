import type { GitHubRepositoryList } from "@/lib/github/client";

/**
 * How long a user's repository listing is reused. Short: it is there so
 * opening the picker, closing it, and opening it again (or two pickers on one
 * page) costs one listing, not to stand in for GitHub. Anything that needs the
 * current answer asks for a fresh one.
 */
export const REPOSITORY_CACHE_TTL_MS = 30_000;

type Entry = { at: number; list: Promise<GitHubRepositoryList> };

/** Per process: Outrunner's server is one long-lived process (server.ts). */
const entries = new Map<string, Entry>();

/**
 * `userId`'s repository listing: the one read in the last
 * {@link REPOSITORY_CACHE_TTL_MS}, or one read now with `load`. A listing
 * still being read is shared rather than started twice. `fresh` always reads
 * anew (and the new one is what later callers reuse).
 *
 * A failed listing is dropped at once, so the next call tries again.
 */
export function cachedRepositoryList(
  userId: string,
  load: () => Promise<GitHubRepositoryList>,
  { fresh = false, now = Date.now() }: { fresh?: boolean; now?: number } = {},
): Promise<GitHubRepositoryList> {
  pruneExpired(now);
  const cached = entries.get(userId);
  if (cached && !fresh) return cached.list;

  const entry: Entry = { at: now, list: load() };
  entries.set(userId, entry);
  entry.list.catch(() => {
    // Only this attempt's entry: a fresh one started since stays.
    if (entries.get(userId) === entry) entries.delete(userId);
  });
  return entry.list;
}

/** Forget every cached listing (tests). */
export function clearRepositoryCache(): void {
  entries.clear();
}

function pruneExpired(now: number): void {
  for (const [userId, entry] of entries) {
    if (now - entry.at >= REPOSITORY_CACHE_TTL_MS) entries.delete(userId);
  }
}
