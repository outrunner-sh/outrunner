import type { GitHubRepository } from "@/lib/github/client";
import { mapWithConcurrency } from "@/lib/concurrency";
import { isGitHubFullName } from "@/lib/github/listing";

/** The project columns that follow a repository through a rename or transfer. */
export type GitHubRepositoryNaming = Pick<
  GitHubRepository,
  "githubRepoId" | "fullName" | "owner" | "name" | "htmlUrl" | "private" | "defaultBranch"
>;

export type ConnectedGitHubProject = {
  id: string;
  orgId: string;
  githubRepoId: number | null;
  fullName: string;
};

export type ProjectRenameStore = {
  /** The orgs' projects for these GitHub repository IDs. */
  projects(orgIds: readonly string[], githubRepoIds: readonly number[]): Promise<ConnectedGitHubProject[]>;
  /** Write `repository`'s naming onto the project, still matched by org and
   *  repository ID; false when the row no longer matches. */
  rename(project: ConnectedGitHubProject, repository: GitHubRepositoryNaming): Promise<boolean>;
};

/** Refresh metadata of existing projects, preserving their IDs and grants.
 * Names alone never establish identity: an old name can be reused by another
 * repository. Partial listings update what was verified without removing or
 * connecting projects. The orgs must be links of the verified installation. */
export async function refreshConnectedGitHubNames(
  orgIds: readonly string[],
  repositories: readonly GitHubRepositoryNaming[],
  store: ProjectRenameStore,
): Promise<number> {
  const scope = new Set(orgIds);
  const verified = new Map(repositories
    .filter((repo) => Number.isSafeInteger(repo.githubRepoId) && repo.githubRepoId > 0 && isGitHubFullName(repo.fullName))
    .map((repo) => [repo.githubRepoId, repo]));
  if (scope.size === 0 || verified.size === 0) return 0;

  const projects = await store.projects([...scope], [...verified.keys()]);
  const changed = projects.filter((project) =>
    scope.has(project.orgId) && project.githubRepoId !== null &&
    verified.has(project.githubRepoId) && verified.get(project.githubRepoId)!.fullName !== project.fullName,
  );
  const updated = await mapWithConcurrency(changed, 6, (project) =>
    store.rename(project, verified.get(project.githubRepoId!)!));
  return updated.filter(Boolean).length;
}

export type InstallationRenameDeps = ProjectRenameStore & {
  holder(installationId: number): Promise<{ orgIds: string[]; suspended: boolean } | null>;
  token(installationId: number): Promise<string>;
  /** Every repository the installation reaches. */
  listRepositories(token: string): Promise<GitHubRepository[]>;
  /** One repository as the installation sees it now; null when it can't. */
  repository(token: string, githubRepoId: number): Promise<GitHubRepository | null>;
};

/** Keep an installation's connected projects in step with GitHub after a
 * rename or transfer. With `githubRepoIds`, only those repositories are read,
 * each by its stable ID: a webhook's payload is never trusted for the name,
 * since a late or redelivered event would roll a project back to a stale one.
 * Without, the installation's whole listing is read. A suspended installation
 * is skipped, as GitHub refuses it a token. Never creates projects, changes
 * project ownership or grants, or reaches outside the installation's org links. */
export async function refreshInstallationProjectNames(
  installationId: number,
  githubRepoIds: readonly number[] | undefined,
  deps: InstallationRenameDeps,
): Promise<number> {
  const holder = await deps.holder(installationId);
  if (!holder || holder.suspended || holder.orgIds.length === 0) return 0;
  if (githubRepoIds && githubRepoIds.length === 0) return 0;
  const token = await deps.token(installationId);
  const repositories = githubRepoIds
    ? (await Promise.all(githubRepoIds.map((id) => deps.repository(token, id))))
      .filter((repo): repo is GitHubRepository => repo !== null)
    : await deps.listRepositories(token);
  return refreshConnectedGitHubNames(holder.orgIds, repositories, deps);
}
