import { NextResponse } from "next/server";

import { savingAutomation } from "@/lib/automations/routes";
import { parseAutomationInput } from "@/lib/automations/rules";
import { createAutomation, requestDelegation } from "@/lib/db/automations";
import { checkMissionTarget } from "@/lib/missions/mission-automations";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Make an automation in an org: its admins may. It runs as the admin who
 * made it (their Claude and plan), on the org's repositories it names.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;

  const parsed = parseAutomationInput(await request.json().catch(() => null), { full: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingAutomation(async () => {
    // A Mission's destination: write on its project, its repository its
    // project's, and its owner's approval (lib/missions/mission-automations.ts).
    const target = await checkMissionTarget(id, caller.owner.id, parsed.value, null, { mission: sessionById, level: missionLevel });
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
    const automationId = await createAutomation(id, caller.owner.id, { ...parsed.value, ...target.input });
    if (target.mission) {
      await requestDelegation(automationId, target.mission.id, caller.owner.id, target.mission.ownerId === caller.owner.id);
    }
    return NextResponse.json({ id: automationId }, { status: 201 });
  });
}
