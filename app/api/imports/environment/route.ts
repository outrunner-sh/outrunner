import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { mergeIntoDefaultEnvironment } from "@/lib/db/environments";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import { getGitHubRepository } from "@/lib/github/client";
import { connectRepositories } from "@/lib/github/connect";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { ImportError } from "@/lib/imports/commit";
import { importEnvironment } from "@/lib/imports/environment";
import { ImportEnvironmentRequest } from "@/lib/runtime/import-scan";

/**
 * Keep the environment the user picked of a repository on their Mac (the
 * desktop app read its values) for its cloud sessions, sealed. New sessions,
 * and restored ones, start with it.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = ImportEnvironmentRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a repository's environment from a scan." }, { status: 400 });
  }

  try {
    const token = await requireGithubToken(owner.id);
    const result = await importEnvironment(parsed.data, {
      async projectFor(repo) {
        const { repositories } = await connectRepositories(owner.id, token, [repo], {
          lookup: getGitHubRepository,
          upsert: upsertProjects,
        });
        const repository = repositories[0];
        if (!repository) return null;
        return (await listProjects()).find((p) => p.githubRepoId === repository.githubRepoId)?.id ?? null;
      },
      merge: (projectId, add) => mergeIntoDefaultEnvironment(owner.id, projectId, add),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EnvironmentRuleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return (
      databaseNotUpdated(error, `${parsed.data.repo}'s environment`) ??
      githubErrorResponse(error, "Could not keep that environment. Please try again.")
    );
  }
}
