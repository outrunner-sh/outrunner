import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import { listGitHubRepositories } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/response";
import { requireGithubToken } from "@/lib/github/token";

export const dynamic = "force-dynamic";

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  // A configured public origin takes precedence over request headers, which
  // avoids trusting a forwarded host at a proxy boundary.
  const baseUrl = optionalEnv("RUNTIME_BASE_URL") ?? request.url;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Connect repositories as projects.
 *
 * With `{ repoIds: [...] }`, only those repositories are connected — the picker
 * posts the user's selection, so browsing hundreds of repositories does not
 * turn all of them into projects. With no body, every repository the user's
 * GitHub token can reach is connected (the original bulk behaviour, still used
 * by the plain "Sync repositories" button).
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
  let selection: Set<number> | null = null;
  const body = (await request.json().catch(() => null)) as { repoIds?: unknown } | null;
  if (body && Array.isArray(body.repoIds)) {
    const ids = body.repoIds.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id),
    );
    if (ids.length === 0) {
      return NextResponse.json({ error: "Select at least one repository." }, { status: 400 });
    }
    selection = new Set(ids);
  }

  try {
    const all = await listGitHubRepositories(await requireGithubToken(owner.id));
    // Filter against what GitHub actually returned rather than trusting the
    // posted ids: a repo the token cannot see must not become a project row.
    const repositories = selection
      ? all.filter((r) => selection.has(r.githubRepoId))
      : all;
    const synced = await upsertProjects(owner.id, repositories);
    // Return the projects too: the composer connects a repository and needs its
    // project id in the same round trip to start a session on it.
    return NextResponse.json({ synced, discovered: all.length, projects: await listProjects() });
  } catch (error) {
    const githubError = githubErrorResponse(error);
    if (githubError) return githubError;

    console.error("Repository sync failed", error);
    return NextResponse.json(
      { error: "Could not save repositories. Check Outrunner's setup and try again." },
      { status: 500 },
    );
  }
}
