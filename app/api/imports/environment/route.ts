import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { EnvironmentAccessError, EnvironmentConflictError, mergeIntoDefaultEnvironment } from "@/lib/db/environments";
import { listProjects, upsertProjects } from "@/lib/db/repositories";
import { connectRepositories } from "@/lib/github/connect";
import { githubErrorResponse } from "@/lib/github/http";
import { repositorySource } from "@/lib/github/repository-source";
import { isSameOriginRequest } from "@/lib/http/guards";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { ImportError } from "@/lib/imports/commit";
import { importEnvironment } from "@/lib/imports/environment";
import { ImportEnvironmentRequest } from "@/lib/runtime/import-scan";
import { connectRefusal } from "@/lib/orgs/connect-access";
import { activeOrgId } from "@/lib/orgs/server";

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
    // Into the active org, where the user is looking.
    const orgId = await activeOrgId();
    const refused = await connectRefusal(owner.id, orgId);
    if (refused) return refused;
    const { lookup } = await repositorySource(owner.id, orgId);
    const result = await importEnvironment(parsed.data, {
      async projectFor(repo) {
        const { repositories } = await connectRepositories(owner.id, [repo], {
          lookup,
          upsert: (ownerId, repos) => upsertProjects(ownerId, repos, orgId),
        });
        const repository = repositories[0];
        if (!repository) return null;
        return (await listProjects(orgId)).find((p) => p.githubRepoId === repository.githubRepoId)?.id ?? null;
      },
      merge: async (projectId, add) => {
        if (!(await mergeIntoDefaultEnvironment(owner.id, projectId, add))) {
          throw new ImportError("That repository isn't in one of your orgs. Connect it there first.", 404);
        }
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof EnvironmentRuleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof EnvironmentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof EnvironmentAccessError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return (
      databaseNotUpdated(error, `${parsed.data.repo}'s environment`) ??
      githubErrorResponse(error, "Could not keep that environment. Please try again.")
    );
  }
}
