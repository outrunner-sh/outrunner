import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { readMissionSpend } from "@/lib/missions/spend.deps";
import { ownsMission } from "@/lib/missions/view.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * What one of the owner's Missions and its Ships spent in a period
 * (docs/mission-spend.md): `?period=day|week` (default day), the UTC day or
 * ISO week (from Monday 00:00 UTC) that `?at=` (an ISO time; default now) is
 * in. Each figure says its coverage; an unknown one is null, never 0.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  if (!(await ownsMission(owner.id, id))) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? "day";
  if (period !== "day" && period !== "week") {
    return NextResponse.json({ error: "period is day or week." }, { status: 400 });
  }
  const atParam = params.get("at");
  const at = atParam ? new Date(atParam) : new Date();
  if (Number.isNaN(at.getTime())) return NextResponse.json({ error: "at is an ISO time." }, { status: 400 });
  const spend = await readMissionSpend(id, period, at);
  return NextResponse.json({ spend }, { headers: { "cache-control": "no-store" } });
}
