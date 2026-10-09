import { NextResponse } from "next/server";

import { createTeamInvite } from "@/lib/db/teams";
import { optionalEnv } from "@/lib/env";
import { teamCaller, teamFailure, teamRoleOf } from "@/lib/teams/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Make an invite link with a role (owners and admins; admins invite members
 * and viewers). The link is returned once: only its hash is kept.
 */
export async function POST(request: Request, context: RouteContext) {
  const caller = await teamCaller(request);
  if (caller instanceof NextResponse) return caller;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = teamRoleOf(body?.role);
  if (!role || role === "owner") {
    return NextResponse.json({ error: "Invite as an admin, member or viewer." }, { status: 400 });
  }
  try {
    const invite = await createTeamInvite(id, role);
    const base = optionalEnv("RUNTIME_BASE_URL") ?? new URL(request.url).origin;
    return NextResponse.json(
      { invite: { id: invite.id, role, url: new URL(`/invite/${invite.token}`, base).toString() } },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return teamFailure(error, "make the invite");
  }
}
