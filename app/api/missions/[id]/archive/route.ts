import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { archiveMission, unsavedNote } from "@/lib/missions/archive";
import { missionArchiveDeps } from "@/lib/missions/archive.deps";
import { ownsMission } from "@/lib/missions/view.deps";

// Each Ship's worktree is saved as it's archived, a few at a time; none is
// started on past ARCHIVE_BUDGET_MS, so the last end inside this (serverless
// hosts only; a no-op on a long-running server). The browser asks again for
// the rest.
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

/** Archive one of the owner's Runners with its Ships (lib/missions/archive.ts). */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const mission = await ownsMission(owner.id, id);
  if (!mission) return NextResponse.json({ error: "Runner not found." }, { status: 404 });
  const result = await archiveMission(mission, missionArchiveDeps());
  if (!result.archived) {
    // Ships archived without their files on an ask that ran out of time
    // (`more`) are said once the last ask ends: the browser keeps the note.
    const note = result.more && result.unsaved ? { note: unsavedNote(result.unsaved) } : {};
    return NextResponse.json({ error: result.why, ships: result.ships, left: result.left, more: result.more, ...note }, { status: 409 });
  }
  // `note`: Ships archived without their files, their boxes out of reach.
  return NextResponse.json({ ok: true, ships: result.ships, ...(result.note && { note: result.note }) });
}
