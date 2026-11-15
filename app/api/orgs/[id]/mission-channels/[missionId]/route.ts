import { NextResponse } from "next/server";

import { isUuid } from "@/lib/ids";
import { disconnectBoundChannel } from "@/lib/missions/mission-channels-list";
import { disconnectDeps } from "@/lib/missions/mission-channels-list.deps";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string; missionId: string }> };

/**
 * Disconnect, from Settings: take an org's Mission off call the one way
 * there is (takeOffCall), for a member with write on its project, whoever
 * owns it, as `@Outrunner stop being on call here` allows. The Mission's
 * own route (/api/missions/[id]/slack) is its owner's alone.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, missionId } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  if (!isUuid(missionId)) return NextResponse.json({ error: "That Mission isn't on call in this org." }, { status: 404 });
  const outcome = await disconnectBoundChannel(caller.owner.id, id, missionId, disconnectDeps);
  if (outcome === "not_found") return NextResponse.json({ error: "That Mission isn't on call in this org." }, { status: 404 });
  if (outcome === "forbidden") return NextResponse.json({ error: "That needs write on the Mission's project." }, { status: 403 });
  return NextResponse.json({ ok: true });
}
