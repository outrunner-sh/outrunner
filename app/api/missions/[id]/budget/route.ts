import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { missionBudgetView, setMissionBudget } from "@/lib/missions/budget.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A Mission's daily and weekly dollar budgets (docs/missions.md, "Budgets"),
 * for its header and the Hire screen: GET its limits, this day's and week's
 * spend with coverage, and whether it's budget-paused (its owner, or anyone
 * who can read its project); PUT `{ dailyUsd, weeklyUsd }` (each dollars or
 * null; both null: no budget) as its owner or with write on its project.
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getOwner();
  if (!user) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const answer = await missionBudgetView(id, user.id);
  if ("error" in answer) return NextResponse.json({ error: answer.error }, { status: answer.status });
  return NextResponse.json(answer.view, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getOwner();
  if (!user) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { dailyUsd?: unknown; weeklyUsd?: unknown } | null;
  if (!body || typeof body !== "object" || !("dailyUsd" in body) || !("weeklyUsd" in body)) {
    return NextResponse.json({ error: "Send { dailyUsd, weeklyUsd }: each dollars, or null for no limit." }, { status: 400 });
  }
  const answer = await setMissionBudget(id, { dailyUsd: body.dailyUsd, weeklyUsd: body.weeklyUsd }, user.id);
  if ("error" in answer) return NextResponse.json({ error: answer.error }, { status: answer.status });
  return NextResponse.json(answer.view, { headers: { "cache-control": "no-store" } });
}
