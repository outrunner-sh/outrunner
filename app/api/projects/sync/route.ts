import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { mapWithConcurrency } from "@/lib/concurrency";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import { loadRepositoryBrowse } from "@/lib/github/browse";
import { getGitHubRepository, type GitHubRepository, type GitHubRepositoryList } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { isGitHubFullName } from "@/lib/github/listing";
import { reconcileProjects } from "@/lib/github/reconcile-projects";
import { cachedRepositoryBrowse, forgetRepositoryBrowse } from "@/lib/github/repository-cache";
import { requireGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";

export const dynamic = "force-dynamic";

/** Repositories one request may connect by name or id; the pickers send one. */
const MAX_SELECTION = 100;
/** Lookups of selected repositories run at once. */
const LOOKUP_CONCURRENCY = 6;

/**
 * Connect repositories as projects.
 *
 * With `{ repoIds: [...] }` and/or `{ fullNames: ["owner/name", ...] }` (a
 * pasted URL), only those repositories are connected — the picker posts the
 * user's selection, so browsing hundreds of repositories does not turn all of
 * them into projects. Each is looked up on GitHub rather than trusting what
 * was posted: a repository the token cannot see must not become a project
 * row. `repoIds` in the response are the ones connected (a renamed
 * repository's name resolves to its current one). With no body, every repository the user's GitHub token can
 * reach is connected (the original bulk behaviour, still used by the plain
 * "Sync repositories" button).
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in to Outrunner first." },
      { status: 401 },
    );
  }

  // An absent or unparseable body means "connect everything"; only an explicit
  // array narrows the selection.
  let selection: Array<number | string> | null = null;
  const body = (await request.json().catch(() => null)) as { repoIds?: unknown; fullNames?: unknown } | null;
  if (body && (Array.isArray(body.repoIds) || Array.isArray(body.fullNames))) {
    const ids = (Array.isArray(body.repoIds) ? body.repoIds : []).filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    const names = (Array.isArray(body.fullNames) ? body.fullNames : []).filter(
      (name): name is string => typeof name === "string" && isGitHubFullName(name),
    );
    if (ids.length + names.length === 0) {
      return NextResponse.json({ error: "Select at least one repository." }, { status: 400 });
    }
    selection = [...new Set<number | string>([...ids, ...names])];
    if (selection.length > MAX_SELECTION) {
      return NextResponse.json(
        { error: `Connect at most ${MAX_SELECTION} repositories at a time.` },
        { status: 400 },
      );
    }
  }

  try {
    const token = await requireGithubToken(owner.id);
    let repositories: GitHubRepository[];
    let list: GitHubRepositoryList | null = null;
    if (selection) {
      const found = await mapWithConcurrency(selection, LOOKUP_CONCURRENCY, (ref) =>
        getGitHubRepository(token, ref),
      );
      // An id and a name (or two spellings of one) can be the same repository,
      // and one upsert must not write a row twice.
      const byId = new Map<number, GitHubRepository>();
      for (const repo of found) if (repo) byId.set(repo.githubRepoId, repo);
      repositories = [...byId.values()];
      if (repositories.length === 0) {
        return NextResponse.json(
          { error: "Your GitHub account can't see that repository. Check the name, or refresh the list." },
          { status: 404 },
        );
      }
    } else {
      // A fresh listing, which the picker then reuses for its next few seconds.
      const { browse } = await cachedRepositoryBrowse(owner.id, () => loadRepositoryBrowse(token), {
        fresh: true,
      });
      list = browse.list;
      repositories = list.repositories;
    }
    const synced = await upsertProjects(owner.id, repositories);
    if (list) {
      // Everything was just read: a project GitHub no longer lists is marked
      // lost. Follow-up work: the repositories are saved whatever it says.
      await reconcileProjects(owner.id, token, await listProjects(), list).catch((error: unknown) => {
        console.error("Could not bring projects up to date with GitHub", error);
      });
    } else {
      // Just connected from their own lookups, newer than any listing cached.
      forgetRepositoryBrowse(owner.id);
    }
    // Return the projects too: the composer connects a repository and needs its
    // project id in the same round trip to start a session on it.
    return NextResponse.json({
      synced,
      discovered: repositories.length,
      repoIds: repositories.map((repo) => repo.githubRepoId),
      complete: list?.complete ?? true,
      projects: await listProjects(),
    });
  } catch (error) {
    return githubErrorResponse(
      error,
      "Could not save repositories. Check Outrunner's setup and try again.",
    );
  }
}
