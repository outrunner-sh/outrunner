import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  CURRENT_TEAM_COOKIE,
  deleteTeamRow,
  renameTeam,
  teamComputersForDeletion,
  teamRole,
} from "@/lib/db/teams";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { teamCaller, teamFailure, teamName } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

// Deleting destroys every member's computer on the team's projects first.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Rename a workspace (owners and admins). */
export async function PATCH(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = teamName(body?.name);
  if (!name) {
    return NextResponse.json({ error: "Name the workspace (up to 80 characters)." }, { status: 400 });
  }
  try {
    await renameTeam(id, name);
    return NextResponse.json({ team: { id, name } });
  } catch (error) {
    return teamFailure(error, "rename the workspace");
  }
}

/**
 * Delete a workspace (owners, never a personal one), with its projects and
 * sessions. Every member's Runtime Computer on its projects is destroyed first:
 * their rows go with the team, but a box left running would bill forever.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { id } = await context.params;
  if ((await teamRole(id, caller.id)) !== "owner") {
    return NextResponse.json({ error: "Only a workspace's owners delete it." }, { status: 403 });
  }

  try {
    const computers = (await teamComputersForDeletion(id)).filter((c) => c.sandboxId);
    if (computers.length) {
      const provider = getRuntimeProvider();
      if (!(provider instanceof DaytonaRuntimeProvider)) {
        return NextResponse.json(
          { error: "This workspace's computers can't be shut down from here; nothing was deleted." },
          { status: 409 },
        );
      }
      await Promise.all(computers.map((c) => provider.destroyComputer(c.sandboxId as string)));
    }
    await deleteTeamRow(id);
  } catch (error) {
    return teamFailure(error, "delete the workspace");
  }

  const response = NextResponse.json({ deleted: id });
  // Back to the personal workspace if this one was open.
  if ((await cookies()).get(CURRENT_TEAM_COOKIE)?.value === id) {
    response.cookies.delete(CURRENT_TEAM_COOKIE);
  }
  return response;
}
