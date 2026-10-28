import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { MISSION_ICONS } from "@/lib/missions/icons";
import { missionsFor, ownsMission, setMissionProfile } from "@/lib/missions/view.deps";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

/** One of the owner's Missions, with its Runners grouped (the Runners pane). */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const [mission] = await missionsFor(owner.id, null, id);
  if (!mission) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  return NextResponse.json({ mission }, { headers: { "cache-control": "no-store" } });
}

/** Rename the Mission, or give it another icon from the set. */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  if (!(await ownsMission(owner.id, id))) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { title?: unknown; icon?: unknown } | null;
  // Both checked before either is written: a change lands whole or not at all.
  const icon = typeof body?.icon === "string" ? body.icon : null;
  const title = typeof body?.title === "string" ? body.title.trim().replace(/\s+/g, " ") : null;
  if (icon !== null && !MISSION_ICONS.some((i) => i.key === icon)) return NextResponse.json({ error: "Choose one of the icons." }, { status: 400 });
  if (title !== null && (!title || title.length > 120)) return NextResponse.json({ error: "A name of 1 to 120 characters." }, { status: 400 });
  if (title !== null) {
    // As the owner, under their row's policy: a row it filters out is no
    // rename, said as one.
    const { data, error } = await (await createSupabaseServerClient()).from("workspaces").update({ title }).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }
  if (icon !== null) await setMissionProfile(id, { icon });
  return NextResponse.json({ ok: true });
}
