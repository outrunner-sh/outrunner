import type { RepositoryBrowse } from "@/lib/github/browse";

/**
 * How long a user's repository listing is reused once read. Short: it is there
 * so opening the picker, closing it, and opening it again (or two pickers on
 * one page) costs one listing, not to stand in for GitHub. Anything that needs
 * the current answer asks for a fresh one.
 */
export const REPOSITORY_CACHE_TTL_MS = 30_000;

type Entry = {
  browse: Promise<RepositoryBrowse>;
  /** When the listing came in; null while it is still being read, which
   *  never expires, so a slow one is shared to the end, not started twice. */
  readAt: number | null;
};

/** Per process: Outrunner's server is one long-lived process (server.ts). */
const entries = new Map<string, Entry>();

/** A listing, and whether this call is the one that read it from GitHub
 *  (rather than reusing one read earlier, or being read for another call). */
export type CachedRepositoryBrowse = { browse: RepositoryBrowse; readNow: boolean };

/**
 * `userId`'s repository listing, with its organizations and invitations: one
 * being read now, or one read in the last {@link REPOSITORY_CACHE_TTL_MS};
 * otherwise one read now with `load`. `fresh` always reads anew (and the new one is what later callers reuse).
 *
 * A failed listing is dropped at once, so the next call tries again.
 */
export async function cachedRepositoryBrowse(
  userId: string,
  load: () => Promise<RepositoryBrowse>,
  { fresh = false, clock = Date.now }: { fresh?: boolean; clock?: () => number } = {},
): Promise<CachedRepositoryBrowse> {
  pruneExpired(clock());
  const cached = entries.get(userId);
  if (cached && !fresh) return { browse: await cached.browse, readNow: false };

  const entry: Entry = { browse: load(), readAt: null };
  entries.set(userId, entry);
  entry.browse.then(
    () => {
      entry.readAt = clock();
    },
    () => {
      // Only this attempt's entry: a fresh one started since stays.
      if (entries.get(userId) === entry) entries.delete(userId);
    },
  );
  return { browse: await entry.browse, readNow: true };
}

/**
 * Forget `userId`'s listing, after a change it would not show: a repository
 * just connected from its own lookup is newer than any listing read before.
 */
export function forgetRepositoryBrowse(userId: string): void {
  entries.delete(userId);
}

/** Forget every cached listing (tests). */
export function clearRepositoryCache(): void {
  entries.clear();
}

function pruneExpired(now: number): void {
  for (const [userId, entry] of entries) {
    if (entry.readAt !== null && now - entry.readAt >= REPOSITORY_CACHE_TTL_MS) entries.delete(userId);
  }
}
