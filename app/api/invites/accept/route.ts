import { NextResponse } from "next/server";

import { acceptTeamInvite } from "@/lib/db/teams";
import { teamCaller, teamFailure, withCurrentTeam } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

/** Join the workspace an invite link is for, and switch to it. */
export async function POST(request: Request) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !body.token) {
    return NextResponse.json({ error: "That invite link is incomplete." }, { status: 400 });
  }
  try {
    const teamId = await acceptTeamInvite(body.token);
    return withCurrentTeam(NextResponse.json({ team: { id: teamId } }), teamId);
  } catch (error) {
    return teamFailure(error, "join the workspace");
  }
}
