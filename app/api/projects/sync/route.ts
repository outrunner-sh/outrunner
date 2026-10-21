import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import { getGitHubRepository, listGitHubRepositories, type GitHubRepository } from "@/lib/github/client";
import { connectRepositories } from "@/lib/github/connect";
import { githubErrorResponse } from "@/lib/github/http";
import { cachedRepositoryList } from "@/lib/github/repository-cache";
import { requireGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";

/** Repositories one request may connect by id; the picker sends one. */
const MAX_SELECTION = 100;

/**
 * Connect repositories as projects.
 *
 * With `{ repoIds: [...] }`, only those repositories are connected — the picker
 * posts the user's selection, so browsing hundreds of repositories does not
 * turn all of them into projects. Each is looked up on GitHub by id rather than
 * trusting the posted ids: a repository the token cannot see must not become a
 * project row. With no body, every repository the user's GitHub token can
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
  let selection: number[] | null = null;
  const body = (await request.json().catch(() => null)) as { repoIds?: unknown } | null;
  if (body && Array.isArray(body.repoIds)) {
    const ids = body.repoIds.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    if (ids.length === 0) {
      return NextResponse.json({ error: "Select at least one repository." }, { status: 400 });
    }
    selection = [...new Set(ids)];
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
    let synced: number;
    let complete = true;
    if (selection) {
      ({ repositories, synced } = await connectRepositories(owner.id, token, selection, {
        lookup: getGitHubRepository,
        upsert: upsertProjects,
      }));
      if (repositories.length === 0) {
        return NextResponse.json(
          { error: "Your GitHub account can't see that repository any more. Refresh the list and try again." },
          { status: 404 },
        );
      }
    } else {
      // A fresh listing, which the picker then reuses for its next few seconds.
      const list = await cachedRepositoryList(owner.id, () => listGitHubRepositories(token), {
        fresh: true,
      });
      repositories = list.repositories;
      complete = list.complete;
      synced = await upsertProjects(owner.id, repositories);
    }
    // Return the projects too: the composer connects a repository and needs its
    // project id in the same round trip to start a session on it.
    return NextResponse.json({
      synced,
      discovered: repositories.length,
      complete,
      projects: await listProjects(),
    });
  } catch (error) {
    return githubErrorResponse(
      error,
      "Could not save repositories. Check Outrunner's setup and try again.",
    );
  }
}
