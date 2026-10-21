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
  /** Repositories of projects GitHub stopped listing, to mark lost. */
  lost: number[];
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
 * A project missing from the listing is marked lost only when the listing is
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
  const lost: number[] = [];
  for (const project of projects) {
    const repo = byId.get(project.githubRepoId);
    if (repo) {
      if (project.accessLostAt !== null || detailsChanged(project, repo)) refresh.push(repo);
    } else if (wholeAnswer && project.accessLostAt === null) {
      lost.push(project.githubRepoId);
    }
  }
  return { refresh, lost };
}
