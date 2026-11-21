import type { BranchList } from "@/lib/github/client";

/** How many branches the new-session screen's picker shows at once: past
 *  that, typing narrows them. */
export const BRANCHES_SHOWN = 50;

/** What the picker's search sends, at most. */
export const MAX_BRANCH_QUERY = 100;

/** The branches a new session may start from (GET /api/projects/[id]/branches). */
export type BaseBranches = {
  /** The repository's default branch first, when it matches. */
  branches: string[];
  /** False when the repository has more matching branches than these. */
  complete: boolean;
};

/**
 * The branches to offer for `query`: the repository's default branch first
 * (it is the one most sessions start from), then the rest by name.
 */
export function baseBranchChoices(found: BranchList, defaultBranch: string, query: string): BaseBranches {
  const q = query.trim().toLowerCase();
  const others = found.branches.filter((b) => b !== defaultBranch);
  const withDefault = !q || defaultBranch.toLowerCase().includes(q);
  return {
    branches: withDefault ? [defaultBranch, ...others] : others,
    complete: found.total <= found.branches.length,
  };
}
