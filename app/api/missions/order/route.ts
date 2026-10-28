import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { setMissionOrder } from "@/lib/missions/view.deps";

/** The order the owner dragged their Missions into, in the sidebar. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  // Each once, where it first appears.
  const ids = [...new Set(Array.isArray(body?.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [])].slice(0, 200);
  await setMissionOrder(owner.id, ids);
  return NextResponse.json({ ok: true });
}
