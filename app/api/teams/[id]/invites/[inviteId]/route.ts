import { NextResponse } from "next/server";

import { revokeTeamInvite } from "@/lib/db/teams";
import { teamCaller, teamFailure } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; inviteId: string }> };

/** Revoke an invite link (owners and admins). */
export async function DELETE(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { inviteId } = await context.params;
  try {
    await revokeTeamInvite(inviteId);
    return NextResponse.json({ revoked: inviteId });
  } catch (error) {
    return teamFailure(error, "revoke the invite");
  }
}
