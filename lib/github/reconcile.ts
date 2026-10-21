import type { GitHubRepository, GitHubRepositoryList } from "@/lib/github/client";
import type { Project } from "@/lib/runtime/types";

/** What bringing the user's projects up to date with a listing would write. */
export type ProjectReconcilePlan = {
  /**
   * Repositories to write back over their projects: their details changed on
   * GitHub (a rename, a new default branch, a push), or they were marked lost
   * and GitHub lists them again.
   */
  refresh: GitHubRepository[];
  /**
   * Repositories of projects GitHub stopped listing. Not yet lost: the
   * listing holds only repositories the user owns, collaborates on, or has
   * through an organization, so a public one connected by id, or one the user
   * stopped collaborating on, is missing yet still readable. Each is looked up
   * before it is marked (lib/github/reconcile-projects.ts).
   */
  missing: number[];
};

/** Whether two timestamps name the same instant: Postgres hands back
 *  `+00:00` where GitHub sent `Z`, which is no change. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

function detailsChanged(project: Project, repo: GitHubRepository): boolean {
  return (
    project.fullName !== repo.fullName ||
    project.owner !== repo.owner ||
    project.name !== repo.name ||
    project.defaultBranch !== repo.defaultBranch ||
    project.private !== repo.private ||
    project.language !== repo.language ||
    project.description !== repo.description ||
    project.htmlUrl !== repo.htmlUrl ||
    !sameInstant(project.pushedAt, repo.pushedAt)
  );
}

/**
 * Compare the user's connected projects with a listing of their GitHub
 * repositories, and say what to write so the projects match. Matching is by
 * GitHub's repository id, so a renamed or transferred repository is the same
 * project with new details, not one lost and another found.
 *
 * A project is reported missing from the listing only when the listing is
 * the whole answer: complete, and with no organization left out for single
 * sign-on. Otherwise the repository may simply not have been read, and a
 * project wrongly marked lost would read as access taken away.
 */
export function planProjectReconcile(
  projects: readonly Project[],
  list: GitHubRepositoryList,
): ProjectReconcilePlan {
  const byId = new Map(list.repositories.map((repo) => [repo.githubRepoId, repo]));
  const wholeAnswer = list.complete && list.ssoPartialOrgIds.length === 0;

  const refresh: GitHubRepository[] = [];
  const missing: number[] = [];
  for (const project of projects) {
    const repo = byId.get(project.githubRepoId);
    if (repo) {
      if (project.accessLostAt !== null || detailsChanged(project, repo)) refresh.push(repo);
    } else if (wholeAnswer) {
      // Lost ones too: one that became public is readable again.
      missing.push(project.githubRepoId);
    }
  }
  return { refresh, missing };
}

/**
 * Which of the missing projects' repositories to look up this time, at most
 * `max`, and where the next time starts: a window that moves round them all,
 * so with more than `max` missing every one is reached in turn rather than
 * the same few each time. By id, so the order holds between calls.
 */
export function lookupWindow(
  missing: readonly number[],
  cursor: number,
  max: number,
): { ids: number[]; nextCursor: number } {
  const ordered = [...missing].sort((a, b) => a - b);
  if (ordered.length <= max) return { ids: ordered, nextCursor: 0 };
  const start = cursor % ordered.length;
  const ids = Array.from({ length: max }, (_, i) => ordered[(start + i) % ordered.length]);
  return { ids, nextCursor: (start + max) % ordered.length };
}

/**
 * What the individual lookups of missing projects settle: `found[i]` is what
 * GitHub returned for `checked[i]` — null when the user can't see it,
 * undefined when the lookup failed. Unseen ones are lost; seen ones (public,
 * outside the listing) are not, and are refreshed if their details changed
 * or they had been marked lost; failed ones wait for the next time.
 */
export function settleMissing(
  projects: readonly Project[],
  checked: readonly number[],
  found: readonly (GitHubRepository | null | undefined)[],
): { refresh: GitHubRepository[]; lost: number[] } {
  const refresh: GitHubRepository[] = [];
  const lost: number[] = [];
  checked.forEach((id, i) => {
    const repo = found[i];
    if (repo === undefined) return;
    if (repo === null) {
      lost.push(id);
      return;
    }
    const project = projects.find((p) => p.githubRepoId === id);
    if (project && (project.accessLostAt !== null || detailsChanged(project, repo))) refresh.push(repo);
  });
  return { refresh, lost };
}
