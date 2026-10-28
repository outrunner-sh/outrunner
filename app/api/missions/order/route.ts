import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { ownsMission, setMissionProfile } from "@/lib/missions/view.deps";

/** The order the owner dragged their Missions into, in the sidebar. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((i): i is string => typeof i === "string").slice(0, 200) : [];
  for (const [position, id] of ids.entries()) {
    if (await ownsMission(owner.id, id)) await setMissionProfile(id, { position });
  }
  return NextResponse.json({ ok: true });
}
