import { NextResponse } from "next/server";

import { getProject } from "@/lib/db/repositories";
import { teamRole } from "@/lib/db/teams";
import type { Workspace } from "@/lib/runtime/types";
import { sessionAccess, type SessionAccess } from "@/lib/teams/roles";

/**
 * What the signed-in user may do in a session they can see (one read through
 * RLS): act in it as its creator, manage it as their workspace's owner or
 * admin, or watch it.
 */
export async function sessionAccessFor(workspace: Workspace, userId: string): Promise<SessionAccess> {
  if (workspace.ownerId === userId) return "act";
  const project = await getProject(workspace.projectId);
  return sessionAccess(userId, workspace.ownerId, project ? await teamRole(project.teamId, userId) : null);
}

/** A 403 unless the user started the session: prompts, model switches,
 *  commits and archives are its creator's alone. */
export function onlyItsCreator(workspace: Workspace, userId: string, what: string): NextResponse | null {
  return workspace.ownerId === userId
    ? null
    : NextResponse.json({ error: `Only the person who started this session can ${what}.` }, { status: 403 });
}
