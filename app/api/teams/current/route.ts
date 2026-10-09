import { NextResponse } from "next/server";

import { listMyTeams } from "@/lib/db/teams";
import { teamCaller, withCurrentTeam } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

/** Switch the app to another of the caller's workspaces. */
export async function POST(request: Request) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const body = (await request.json().catch(() => null)) as { teamId?: unknown } | null;
  const teams = await listMyTeams(caller.id);
  const team = teams.find((t) => t.id === body?.teamId);
  if (!team) {
    return NextResponse.json({ error: "You're not in that workspace." }, { status: 404 });
  }
  return withCurrentTeam(NextResponse.json({ team }), team.id);
}
