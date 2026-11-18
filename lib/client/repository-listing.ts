/**
 * The repositories the user could connect to the active org, as every picker
 * reads them — the new-session form's (components/repository-select.tsx) and
 * the environments' (components/repository-picker.tsx) — one listing for the
 * page (app/api/github/repositories, which reuses a listing read in the last
 * few seconds; lib/github/repository-cache.ts), and how picking one
 * connects it.
 */

import { repositoryKey, type CodeProvider } from "@/lib/code-providers/repository";
import { sharedResource, type SharedResource } from "@/lib/client/shared-resource";
import type { ListingSource, RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";

export type Listing = {
  repositories: RepositoryListing[];
  /** Ids (within the provider) of those connected to the org already. */
  connected: number[];
  /** False when GitHub may have more than the list holds. */
  complete: boolean;
  /** Organizations whose repositories single sign-on held back. */
  ssoPartialOrgIds: number[];
  /** The org's GitHub App, or the user's own GitHub. */
  source: ListingSource;
};

/** What went wrong, and for a repository GitHub withheld, which one. */
export type PickerError = { message: string; reconnect: boolean; repo?: string; noAccess?: boolean };

/** Read the API's error body: `reconnect` set when the token is the problem,
 *  `noAccess` when GitHub withheld a repository. */
export async function readError(res: Response, fallback: string): Promise<PickerError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; reconnect?: boolean; code?: string };
  return {
    message: data.error ?? fallback,
    reconnect: data.reconnect === true,
    noAccess: data.code === "repo-no-access",
  };
}

export type ListingAnswer = { listing: Listing; error: null } | { listing: null; error: PickerError };

/** The next look asks GitHub again rather than take the server's recent copy. */
let askGitHubAgain = false;

/**
 * Everything the org's GitHub App reaches (or the user's own GitHub), one
 * listing for the page: looked up as a picker mounts, so it opens on it at
 * once, and again in the background each time it opens. A failure is an
 * answer too, said in the picker.
 */
const GITHUB_REPOSITORIES = sharedResource<ListingAnswer | null>(async () => {
  const fresh = askGitHubAgain;
  askGitHubAgain = false;
  try {
    const res = await fetch(fresh ? "/api/github/repositories?fresh=1" : "/api/github/repositories");
    if (!res.ok) return { listing: null, error: await readError(res, "Couldn't load your repositories from GitHub.") };
    const data = (await res.json()) as Partial<Listing>;
    return {
      listing: {
        repositories: data.repositories ?? [],
        connected: data.connected ?? [],
        complete: data.complete ?? true,
        ssoPartialOrgIds: data.ssoPartialOrgIds ?? [],
        source: data.source ?? { kind: "user" },
      },
      error: null,
    };
  } catch {
    return { listing: null, error: { message: "Couldn't load your repositories from GitHub.", reconnect: false } };
  }
}, null);

const GITLAB_REPOSITORIES = sharedResource<ListingAnswer | null>(async () => {
  try {
    const res = await fetch("/api/gitlab/repositories");
    if (!res.ok) return { listing: null, error: await readError(res, "Couldn't load your GitLab repositories.") };
    const data = (await res.json()) as Partial<Listing>;
    return {
      listing: { repositories: data.repositories ?? [], connected: data.connected ?? [], complete: data.complete ?? true, ssoPartialOrgIds: [], source: { kind: "user" } },
      error: null,
    };
  } catch {
    return { listing: null, error: { message: "Couldn't load your GitLab repositories.", reconnect: false } };
  }
}, null);

/** The page's listing for `provider`. */
export function repositoryListing(provider: CodeProvider): SharedResource<ListingAnswer | null> {
  return provider === "gitlab" ? GITLAB_REPOSITORIES : GITHUB_REPOSITORIES;
}

/** Look again, waiting for the answer: GitHub itself, not the server's
 *  recent copy (a picker's Refresh list). */
export async function refreshListing(provider: CodeProvider): Promise<void> {
  const resource = repositoryListing(provider);
  if (provider === "github") askGitHubAgain = true;
  resource.invalidate();
  await resource.ensure();
}

/** Connecting failed: what the server said (PickerError's parts). */
export class ConnectError extends Error {
  readonly reconnect: boolean;
  readonly noAccess: boolean;
  constructor(error: PickerError) {
    super(error.message);
    this.name = "ConnectError";
    this.reconnect = error.reconnect;
    this.noAccess = error.noAccess === true;
  }
}

/**
 * Connect repositories to the active org (or refresh them, connected
 * already), by their ids on `provider`: GitHub's in one request
 * (POST /api/projects/sync, `{ repoIds }`), GitLab's one at a time. Every
 * project the org has after; ConnectError when the server refuses. The
 * listing is looked at again next time, to mark them connected.
 */
export async function connectRepositories(ids: number[], provider: CodeProvider): Promise<Project[]> {
  const post = async (url: string, body: unknown): Promise<Project[]> => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new ConnectError(await readError(res, "Couldn't connect those repositories. Try again."));
    return ((await res.json()) as { projects?: Project[] }).projects ?? [];
  };
  let projects: Project[] = [];
  try {
    if (provider === "gitlab") {
      for (const repoId of ids) projects = await post("/api/gitlab/projects", { repoId });
    } else {
      projects = await post("/api/projects/sync", { repoIds: ids });
    }
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError({ message: "Couldn't reach Outrunner. Check your connection and try again.", reconnect: false });
  } finally {
    repositoryListing(provider).invalidate();
  }
  return projects;
}

/** The project of a listed repository among `projects`, if it's connected. */
export function projectOf(projects: readonly Project[], repo: RepositoryListing): Project | undefined {
  return projects.find((p) => repositoryKey(p) === repositoryKey(repo));
}
