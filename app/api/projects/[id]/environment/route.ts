import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { environmentHasSetup, findDefaultEnvironmentId } from "@/lib/db/environments";
import { hasProjectEnvironment } from "@/lib/db/project-environment";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Whether the user has kept an environment for the repository's cloud
 * sessions (its default project's variables, files and scripts), and which
 * project that is. Until they have, the new-session form offers the one on
 * their Mac.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  try {
    // The repository's project, if it has one yet (a GET makes none: its
    // first session does); otherwise what was kept for the repository
    // itself, before the migration that adds projects.
    const environmentId = await findDefaultEnvironmentId(owner.id, id);
    const kept = environmentId
      ? await environmentHasSetup(owner.id, environmentId)
      : await hasProjectEnvironment(owner.id, id);
    return NextResponse.json({ kept, environmentId });
  } catch (error) {
    console.error(`Could not read project ${id}'s environment`, error);
    return NextResponse.json({ error: "Could not read this project's environment." }, { status: 502 });
  }
}
