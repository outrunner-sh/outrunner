import { NextResponse } from "next/server";

import { createTeam } from "@/lib/db/teams";
import { teamCaller, teamFailure, teamName, withCurrentTeam } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

/** Create a workspace the caller owns, and switch to it. */
export async function POST(request: Request) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = teamName(body?.name);
  if (!name) {
    return NextResponse.json({ error: "Name the workspace (up to 80 characters)." }, { status: 400 });
  }
  try {
    const id = await createTeam(name);
    return withCurrentTeam(NextResponse.json({ team: { id, name } }, { status: 201 }), id);
  } catch (error) {
    return teamFailure(error, "create the workspace");
  }
}
