import { NextResponse } from "next/server";

import { savingAutomation } from "@/lib/automations/routes";
import { parseAutomationInput } from "@/lib/automations/rules";
import { listRuns } from "@/lib/db/automation-runs";
import { createAutomation, missionAutomations, requestDelegation } from "@/lib/db/automations";
import { checkMissionTarget } from "@/lib/missions/mission-automations";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";
import { missionCaller } from "@/lib/missions/trigger-routes";

/**
 * A Mission's triggers (docs/missions.md, "Triggers"): the automations that
 * send it work, and their runs. Anyone who can read its project sees them;
 * someone with write on it makes one (its owner then approves it, unless
 * it's theirs).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const caller = await missionCaller(request, context, "read");
  if (caller instanceof Response) return caller;
  const automations = await missionAutomations(caller.mission.orgId, caller.mission.id);
  const runs = automations.length ? await listRuns(caller.mission.orgId, 50, undefined, undefined, automations.map((a) => a.id)) : [];
  return NextResponse.json({ automations, runs, isOwner: caller.isOwner }, { headers: { "cache-control": "no-store" } });
}

/** Make a trigger for this Mission: the automation editor's fields, its
 *  destination this Mission. */
export async function POST(request: Request, context: RouteContext) {
  const caller = await missionCaller(request, context, "write");
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const target = { ...((body?.target as Record<string, unknown> | undefined) ?? {}), kind: "mission", missionId: caller.mission.id };
  const parsed = parseAutomationInput({ ...body, target, projectIds: [caller.mission.projectId] }, { full: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingAutomation(async () => {
    const checked = await checkMissionTarget(caller.mission.orgId, caller.userId, parsed.value, null, { mission: sessionById, level: missionLevel });
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
    const automationId = await createAutomation(caller.mission.orgId, caller.userId, { ...parsed.value, ...checked.input });
    await requestDelegation(automationId, caller.mission.id, caller.userId, caller.isOwner);
    return NextResponse.json({ id: automationId, approved: caller.isOwner }, { status: 201 });
  });
}
