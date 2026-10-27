import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listProjects } from "@/lib/db/repositories";
import { listGitHubRepositories } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { toListing } from "@/lib/github/listing";
import { cachedRepositoryList } from "@/lib/github/repository-cache";
import { requireGithubToken } from "@/lib/github/token";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * The repositories this user could connect, read live from GitHub.
 *
 * Deliberately does NOT persist anything — it is the picker's data source, so a
 * user with hundreds of repositories browses them without every one becoming a
 * project row. Connecting is the separate, explicit act (POST /api/projects/sync
 * with the chosen ids).
 *
 * A listing read in the last few seconds is reused (lib/github/repository-cache.ts);
 * `?fresh=1` (the picker's Refresh) reads it anew.
 *
 * `connected` lists the github_repo_ids already synced in the active org, so the picker can show
 * them as checked rather than offering to add them twice. `complete` and
 * `ssoPartialOrgIds` say whether GitHub may have left some out.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to browse repositories." }, { status: 401 });
  }
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    const token = await requireGithubToken(owner.id);
    const [list, projects] = await Promise.all([
      cachedRepositoryList(owner.id, () => listGitHubRepositories(token), { fresh }),
      activeOrgId().then((orgId) => listProjects(orgId)),
    ]);

    return NextResponse.json(
      {
        repositories: list.repositories.map(toListing),
        connected: projects.map((p) => p.githubRepoId),
        complete: list.complete,
        ssoPartialOrgIds: list.ssoPartialOrgIds,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return githubErrorResponse(error, "Could not reach GitHub. Please try again.");
  }
}
