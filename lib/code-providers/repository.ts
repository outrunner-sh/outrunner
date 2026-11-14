import type { RepositoryListing } from "@/lib/github/listing";

/** GitHub keeps its historical owner/name reference. Other hosts are qualified
 * so repositories with the same namespace never share mirrors or credentials. */
export type CodeProvider = "github" | "gitlab";

export type RepositoryRecord = RepositoryListing & { defaultBranch: string; htmlUrl: string };
export type GitLabRepository = RepositoryRecord & { provider: "gitlab"; repositoryId: number; githubRepoId: null };

export function isGitLabRef(ref: string): boolean {
  return ref.startsWith("gitlab.com/");
}

export function gitLabPath(ref: string): string {
  const path = ref.replace(/^gitlab\.com\//, "");
  const parts = path.split("/");
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) || part === "." || part === ".." || part.endsWith(".git"))) {
    throw new Error("Name a GitLab repository as group/project, including any subgroups.");
  }
  return path;
}

export function repositoryRemote(ref: string): string {
  if (isGitLabRef(ref)) return `https://gitlab.com/${gitLabPath(ref)}.git`;
  return `https://github.com/${ref}.git`;
}

export function repositoryKey(repo: { githubRepoId: number | null; provider?: CodeProvider; repositoryId?: number }): string {
  return `${repo.provider ?? "github"}:${repo.repositoryId ?? repo.githubRepoId}`;
}
