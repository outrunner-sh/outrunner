import { NextResponse } from "next/server";

import { getOwner, type Owner } from "@/lib/auth/owner";
import { CURRENT_TEAM_COOKIE, TeamActionError } from "@/lib/db/teams";
import { isSameOriginRequest } from "@/lib/http/guards";
import type { TeamRole } from "@/lib/teams/roles";

/** The caller of a team route that changes something: signed in, same origin. */
export async function teamCaller(request: Request): Promise<Owner | NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  return owner ?? NextResponse.json({ error: "Sign in first." }, { status: 401 });
}

/** A team action's failure: the database's refusal says why; anything else is
 *  logged and reported plainly. */
export function teamFailure(error: unknown, what: string): NextResponse {
  if (error instanceof TeamActionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`Could not ${what}`, error);
  return NextResponse.json({ error: `Couldn't ${what}. Please try again.` }, { status: 500 });
}

/** A workspace name: trimmed, 1–80 characters. */
export function teamName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length >= 1 && name.length <= 80 ? name : null;
}

export function teamRoleOf(raw: unknown): TeamRole | null {
  return raw === "owner" || raw === "admin" || raw === "member" || raw === "viewer" ? raw : null;
}

/** Show this workspace from now on. */
export function withCurrentTeam(response: NextResponse, teamId: string): NextResponse {
  response.cookies.set(CURRENT_TEAM_COOKIE, teamId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
