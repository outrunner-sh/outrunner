import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { optionalEnv } from "@/lib/env";
import { listProjects } from "@/lib/db/repositories";
import { repositoryAccess } from "@/lib/github/access";
import { loadRepositoryBrowse } from "@/lib/github/browse";
import { githubErrorResponse } from "@/lib/github/http";
import { toListing } from "@/lib/github/listing";
import { reconcileProjects } from "@/lib/github/reconcile-projects";
import { cachedRepositoryBrowse } from "@/lib/github/repository-cache";
import { requireGithubToken } from "@/lib/github/token";

export const dynamic = "force-dynamic";

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
 * Each listing read from GitHub also brings the connected projects up to date
 * with it (lib/github/reconcile.ts): new details written back, and ones GitHub no
 * longer lists marked lost. That never holds up or fails the listing.
 *
 * `connected` lists the github_repo_ids already synced, so the picker can show
 * them as checked rather than offering to add them twice. `complete` says
 * whether GitHub may have left some out, and `access` why the user may be
 * missing some: organizations holding them back, and invitations to accept
 * (lib/github/access.ts).
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to browse repositories." }, { status: 401 });
  }
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  try {
    const token = await requireGithubToken(owner.id);
    const [{ browse, readNow }, projects] = await Promise.all([
      cachedRepositoryBrowse(owner.id, () => loadRepositoryBrowse(token), { fresh }),
      listProjects(),
    ]);
    const { list } = browse;
    // Only with a listing read just now: one reused from earlier could write
    // older details over a repository connected since.
    if (readNow) {
      await reconcileProjects(owner.id, token, projects, list).catch((error: unknown) => {
        console.error("Could not bring projects up to date with GitHub", error);
      });
    }

    return NextResponse.json(
      {
        repositories: list.repositories.map(toListing),
        connected: projects.map((p) => p.githubRepoId),
        complete: list.complete,
        access: repositoryAccess({
          repositories: list.repositories,
          complete: list.complete,
          ssoPartialOrgIds: list.ssoPartialOrgIds,
          memberships: browse.memberships,
          invitations: browse.invitations,
          clientId: optionalEnv("GITHUB_OAUTH_CLIENT_ID"),
        }),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return githubErrorResponse(error, "Could not reach GitHub. Please try again.");
  }
}
