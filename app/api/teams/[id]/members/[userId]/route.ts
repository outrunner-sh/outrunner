import { NextResponse } from "next/server";

import { CURRENT_TEAM_COOKIE, removeTeamMember, setTeamMemberRole } from "@/lib/db/teams";
import { teamCaller, teamFailure, teamRoleOf } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; userId: string }> };

/** Change a member's role (owners; a workspace keeps an owner). */
export async function PATCH(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { id, userId } = await context.params;
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = teamRoleOf(body?.role);
  if (!role) {
    return NextResponse.json({ error: "Choose owner, admin, member or viewer." }, { status: 400 });
  }
  try {
    await setTeamMemberRole(id, userId, role);
    return NextResponse.json({ member: { userId, role } });
  } catch (error) {
    return teamFailure(error, "change the role");
  }
}

/** Remove a member, or leave (your own id). */
export async function DELETE(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { id, userId } = await context.params;
  try {
    await removeTeamMember(id, userId);
  } catch (error) {
    return teamFailure(error, userId === caller.id ? "leave the workspace" : "remove them");
  }
  const response = NextResponse.json({ removed: userId });
  if (userId === caller.id) response.cookies.delete(CURRENT_TEAM_COOKIE);
  return response;
}
