import { mapWithConcurrency } from "@/lib/concurrency";
import { isGitHubFullName } from "@/lib/github/listing";

/** Names verified by GitHub's API or a signed repository webhook. */
export type GitHubRepositoryName = { githubRepoId: number; fullName: string };

export type ConnectedGitHubProject = {
  id: string;
  orgId: string;
  githubRepoId: number | null;
  fullName: string;
};

export type CanonicalGitHubName = {
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
};

/** Refresh metadata of existing projects, preserving their IDs and grants.
 * Names alone never establish identity: an old name can be reused by another
 * repository. Partial listings update what was verified without removing or
 * connecting projects. The orgs must be links of the verified installation. */
export async function refreshConnectedGitHubNames(
  orgIds: readonly string[],
  repositories: readonly GitHubRepositoryName[],
  deps: {
    projects(orgIds: readonly string[]): Promise<ConnectedGitHubProject[]>;
    rename(project: ConnectedGitHubProject, canonical: CanonicalGitHubName): Promise<boolean>;
  },
): Promise<number> {
  const scope = new Set(orgIds);
  const verified = new Map(repositories
    .filter((repo) => Number.isSafeInteger(repo.githubRepoId) && repo.githubRepoId > 0 && isGitHubFullName(repo.fullName))
    .map((repo) => [repo.githubRepoId, repo.fullName]));
  if (scope.size === 0 || verified.size === 0) return 0;

  const projects = await deps.projects([...scope]);
  const changed = projects.filter((project) =>
    scope.has(project.orgId) && project.githubRepoId !== null &&
    verified.has(project.githubRepoId) && verified.get(project.githubRepoId) !== project.fullName,
  );
  const updated = await mapWithConcurrency(changed, 6, async (project) => {
    const fullName = verified.get(project.githubRepoId!)!;
    const [owner, name] = fullName.split("/");
    return deps.rename(project, { fullName, owner, name, htmlUrl: `https://github.com/${fullName}` });
  });
  return updated.filter(Boolean).length;
}
