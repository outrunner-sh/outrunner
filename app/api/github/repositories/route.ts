import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listProjects } from "@/lib/db/repositories";
import { currentTeam } from "@/lib/db/teams";
import { GitHubSyncError, listGitHubRepositories } from "@/lib/github/client";
import { MissingGithubTokenError, requireGithubToken } from "@/lib/github/token";

export const dynamic = "force-dynamic";

/**
 * The repositories this user could connect, read live from GitHub.
 *
 * Deliberately does NOT persist anything — it is the picker's data source, so a
 * user with hundreds of repositories browses them without every one becoming a
 * project row. Connecting is the separate, explicit act (POST /api/projects/sync
 * with the chosen ids).
 *
 * `connected` lists the github_repo_ids already in the workspace open in the
 * app, so the picker can show them as checked rather than offering them twice.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to browse repositories." }, { status: 401 });
  }

  try {
    const [repositories, projects] = await Promise.all([
      requireGithubToken(owner.id).then(listGitHubRepositories),
      currentTeam(owner.id).then((team) => (team ? listProjects(team.id) : [])),
    ]);

    return NextResponse.json({
      repositories: repositories.map((r) => ({
        githubRepoId: r.githubRepoId,
        fullName: r.fullName,
        name: r.name,
        owner: r.owner,
        private: r.private,
        language: r.language,
        description: r.description,
        pushedAt: r.pushedAt,
      })),
      connected: projects.map((p) => p.githubRepoId),
    });
  } catch (error) {
    if (error instanceof MissingGithubTokenError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof GitHubSyncError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("Could not list GitHub repositories", error);
    return NextResponse.json(
      { error: "Could not reach GitHub. Please try again." },
      { status: 500 },
    );
  }
}
