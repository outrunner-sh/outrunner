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

/** A GitHub avatar URL at `size` pixels (its `s` parameter), so a list of
 *  them doesn't download each at full size. */
export function avatarAt(url: string, size: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("s", String(size));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The `owner/name` a pasted repository reference names, or null if it isn't
 * a GitHub repository: `owner/name`, its page (`https://github.com/o/r`, with
 * or without `www.`, `.git`, a trailing `/`, or a deeper path such as
 * `/tree/main/src`), or its SSH remote (`git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`). Another host is not GitHub, so it is null.
 */
export function parseGitHubRepoInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  let path: string;
  const scp = /^git@github\.com:(.+)$/i.exec(text);
  if (scp) {
    path = scp[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.)?github\.com\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    path = url.pathname;
  } else {
    path = text;
  }

  const [owner, rawName] = path.replace(/^\/+/, "").split("/");
  if (!owner || !rawName) return null;
  // A bare `owner/name` must be just that; a URL may go deeper than the repo.
  if (path === text && path.split("/").length !== 2) return null;
  const name = rawName.replace(/\.git$/i, "");
  const fullName = `${owner}/${name}`;
  return isGitHubFullName(fullName) ? fullName : null;
}

/** Repositories whose `owner/name` or description contains `query`. */
export function filterRepositories<T extends RepositoryListing>(repos: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  return repos.filter(
    (repo) => repo.fullName.toLowerCase().includes(q) || (repo.description?.toLowerCase().includes(q) ?? false),
  );
}

/** The repositories of one owner, as the open-project dialog lists them. */
export type RepositoryGroup<T extends RepositoryListing = RepositoryListing> = {
  owner: string;
  ownerType: RepositoryListing["ownerType"];
  avatarUrl: string | null;
  /** The signed-in user's own account. */
  viewer: boolean;
  repos: T[];
};

/**
 * Repositories by owner: the signed-in user's own first, then every other
 * account and organization by name. Each keeps the order it was given in
 * (the listing's: most recently pushed first).
 */
export function groupRepositories<T extends RepositoryListing>(
  repos: readonly T[],
  viewerLogin: string | null,
): RepositoryGroup<T>[] {
  const viewer = viewerLogin?.toLowerCase() ?? null;
  const groups = new Map<string, RepositoryGroup<T>>();
  for (const repo of repos) {
    const key = repo.owner.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { owner: repo.owner, ownerType: repo.ownerType, avatarUrl: repo.avatarUrl, viewer: key === viewer, repos: [] };
      groups.set(key, group);
    }
    group.avatarUrl ??= repo.avatarUrl;
    group.ownerType ??= repo.ownerType;
    group.repos.push(repo);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.viewer !== b.viewer) return a.viewer ? -1 : 1;
    return a.owner.toLowerCase().localeCompare(b.owner.toLowerCase());
  });
}
