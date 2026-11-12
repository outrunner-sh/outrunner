import { randomUUID } from "node:crypto";

import { firstFreeBranch, sessionBranch } from "@/lib/session/branch-name";

/** Tries at a generated branch when another session takes it meanwhile. */
export const BRANCH_RACE_ATTEMPTS = 3;

export type GeneratedBranchDeps = {
  /** The branches of `base` and `base-<n>` the project's sessions have had,
   *  ended ones too (lib/db/repositories.ts projectBranchesLike). */
  sessionBranches(base: string): Promise<Set<string>>;
  /** Whether GitHub knows `branch` in any of the session's repositories: as a
   *  branch, or a pull request's head (lib/github/client.ts). */
  knownOnGitHub(branch: string): Promise<boolean>;
};

/**
 * The branch for a session that asked for none: a few words of its title,
 * else of its first prompt (lib/session/branch-name.ts), with `-2`, `-3`…
 * only when that name is taken: by any session of the project, ended ones
 * too, by `lost` (taken by a race just now), or on GitHub. Never a name an
 * old session's pull request or branch has, so its push and its pull request
 * lookup are its own. If that can't be checked, a random suffix keeps it off
 * whatever is there.
 */
export async function generatedBranch(
  about: { title?: string; prompt?: string },
  deps: GeneratedBranchDeps,
  lost: ReadonlySet<string> = new Set(),
): Promise<string> {
  const base = sessionBranch(about);
  try {
    const sessions = await deps.sessionBranches(base);
    const free = await firstFreeBranch(
      base,
      async (branch) => sessions.has(branch) || lost.has(branch) || (await deps.knownOnGitHub(branch)),
    );
    if (free) return free;
  } catch (error) {
    console.error(`Couldn't check which ${base} branches are taken`, error);
  }
  return `${base}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

/**
 * Make the session's row on `branch`, or, for a generated one another
 * session took between the check and the insert (`isBranchTaken`), on the
 * next free name: never a refusal for a branch the user didn't pick. A
 * branch they asked for is tried once, as asked.
 */
export async function insertOnBranch<T>(input: {
  requested: string;
  generate(lost: ReadonlySet<string>): Promise<string>;
  insert(branch: string): Promise<T>;
  isBranchTaken(error: unknown): boolean;
}): Promise<T> {
  const lost = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const branch = input.requested || (await input.generate(lost));
    try {
      return await input.insert(branch);
    } catch (error) {
      if (input.requested || attempt >= BRANCH_RACE_ATTEMPTS || !input.isBranchTaken(error)) throw error;
      lost.add(branch);
    }
  }
}
