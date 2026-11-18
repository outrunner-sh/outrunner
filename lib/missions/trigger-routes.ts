/** The Mission routes' caller check (app/api/missions/[id]/triggers). */

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

type RouteContext = { params: Promise<{ id: string }> };

/** The Mission, and the caller's access to it; or the answer why not. */
export async function missionCaller(request: Request, context: RouteContext, need: "read" | "write") {
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const mission = await sessionById(id).catch(() => null);
  if (!mission || mission.kind !== "mission" || !mission.orgId || mission.status === "destroyed") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }
  const level = await missionLevel(owner.id, mission);
  if (!allows(level, "read")) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  if (need === "write" && !allows(level, "write")) {
    return NextResponse.json({ error: "Changing a Mission's triggers needs write on its project." }, { status: 403 });
  }
  return { userId: owner.id, mission: mission as Workspace & { orgId: string }, isOwner: mission.ownerId === owner.id };
}

