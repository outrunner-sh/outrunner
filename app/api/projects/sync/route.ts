import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import type { GitHubRepository } from "@/lib/github/client";
import { connectRepositories } from "@/lib/github/connect";
import { githubErrorResponse } from "@/lib/github/http";
import { cachedRepositoryList } from "@/lib/github/repository-cache";
import { repositorySource } from "@/lib/github/repository-source";
import { isSameOriginRequest } from "@/lib/http/guards";
import { connectRefusal } from "@/lib/orgs/connect-access";
import { activeOrgId } from "@/lib/orgs/server";

/** Repositories one request may connect by id; the picker sends one. */
const MAX_SELECTION = 100;

/**
 * Connect repositories as projects of the active org (lib/orgs/active.ts).
 *
 * `{ repoIds: [...] }`: only those repositories are connected — the
 * repository picker (components/repository-picker.tsx) posts the user's
 * selection, so browsing hundreds of repositories does not turn all of them
 * into projects. Each is looked up on GitHub by id rather than trusting the
 * posted ids: a repository that can't be seen must not become a project row.
 *
 * (A request with no body still connects every repository there, for older
 * clients; nothing in the app sends one any more.)
 *
 * Seen as the org's GitHub App when it has one installed, else as the user
 * (lib/github/repository-source.ts).
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

  // An absent or unparseable body connects everything (older clients); an
  // explicit array narrows the selection.
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
    const orgId = await activeOrgId();
    const refused = await connectRefusal(owner.id, orgId);
    if (refused) return refused;
    const upsert = (ownerId: string, repos: GitHubRepository[]) => upsertProjects(ownerId, repos, orgId);
    const access = await repositorySource(owner.id, orgId);
    let repositories: GitHubRepository[];
    let synced: number;
    let complete = true;
    if (selection) {
      ({ repositories, synced } = await connectRepositories(owner.id, selection, { lookup: access.lookup, upsert }));
      // Asked for specific repositories and none can be seen: an organization
      // that hasn't approved Outrunner, a repository the App wasn't given, or
      // access since removed. The picker names the repository and says where
      // to grant access.
      if (repositories.length === 0) {
        const accounts = access.source.kind === "app" ? access.source.accounts : [];
        if (accounts.length > 0 && accounts.every((a) => a.suspended)) {
          // Adding the repository on GitHub won't help while it's suspended.
          return NextResponse.json(
            {
              error: `Outrunner's GitHub App is suspended on ${accounts.map((a) => a.login).join(", ")}. Unsuspend it on GitHub first.`,
              code: "app-suspended",
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          {
            error:
              access.source.kind === "app"
                ? "Outrunner's GitHub App can't reach this repository."
                : "GitHub isn't giving Outrunner access to this repository.",
            code: "repo-no-access",
          },
          { status: 403 },
        );
      }
    } else {
      // A fresh listing, which the picker then reuses for its next few seconds.
      const list = await cachedRepositoryList(access.source.key, access.list, { fresh: true });
      repositories = list.repositories;
      complete = list.complete;
      synced = await upsert(owner.id, repositories);
    }
    // Return the projects too: the composer connects a repository and needs its
    // project id in the same round trip to start a session on it.
    return NextResponse.json({
      synced,
      discovered: repositories.length,
      complete,
      projects: await listProjects(orgId),
    });
  } catch (error) {
    return githubErrorResponse(
      error,
      "GitHub listed the repositories, but Outrunner couldn't save them. Try again.",
    );
  }
}
