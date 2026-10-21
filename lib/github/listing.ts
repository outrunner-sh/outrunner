import type { Project } from "@/lib/runtime/types";

/**
 * A repository as the pickers show it: what `/api/github/repositories` returns
 * for each one, and what an already-connected project stands in as before that
 * list arrives. Kept apart from lib/github/client.ts so client components can
 * import it without pulling in the GitHub request code.
 */
export type RepositoryListing = {
  githubRepoId: number;
  fullName: string;
  name: string;
  owner: string;
  /** Whether the owner is the user's own account or an organization; unknown
   *  for a project row, which never stored it. */
  ownerType: "User" | "Organization" | null;
  avatarUrl: string | null;
  private: boolean;
  language: string | null;
  description: string | null;
  pushedAt: string | null;
};

/**
 * Whether `value` is an `owner/name` as GitHub allows them — the same rule the
 * Mac app applies before cloning (runtime-desktop local_runtime.rs
 * `github_repo`), so nothing else (`..`, another path, an option) passes.
 */
export function isGitHubFullName(value: string): boolean {
  const [owner, name, ...rest] = value.split("/");
  if (rest.length > 0 || owner === undefined || name === undefined) return false;
  return (
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) &&
    /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

/** Just a listing's fields, from a repository record that has more (one read
 *  from GitHub also carries its default branch and page URL). */
export function toListing(repo: RepositoryListing): RepositoryListing {
  return {
    githubRepoId: repo.githubRepoId,
    fullName: repo.fullName,
    name: repo.name,
    owner: repo.owner,
    ownerType: repo.ownerType,
    avatarUrl: repo.avatarUrl,
    private: repo.private,
    language: repo.language,
    description: repo.description,
    pushedAt: repo.pushedAt,
  };
}

/** A connected project as a listing row, shown until the live list loads. */
export function projectToListing(project: Project): RepositoryListing {
  return {
    githubRepoId: project.githubRepoId,
    fullName: project.fullName,
    name: project.name,
    owner: project.owner,
    ownerType: null,
    avatarUrl: null,
    private: project.private,
    language: project.language,
    description: project.description,
    pushedAt: project.pushedAt,
  };
}
