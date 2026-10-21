import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { hasProjectEnvironment } from "@/lib/db/project-environment";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Whether the user has kept an environment for the project's cloud sessions.
 * Until they have, the new-session form offers the one on their Mac.
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
    return NextResponse.json({ kept: await hasProjectEnvironment(owner.id, id) });
  } catch (error) {
    console.error(`Could not read project ${id}'s environment`, error);
    return NextResponse.json({ error: "Could not read this project's environment." }, { status: 502 });
  }
}
