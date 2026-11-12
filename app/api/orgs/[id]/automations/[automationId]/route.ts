import { NextResponse } from "next/server";

import { parseAutomationInput } from "@/lib/automations/rules";
import { savingAutomation } from "@/lib/automations/routes";
import { deleteAutomation, getAutomation, updateAutomation } from "@/lib/db/automations";
import { checkMissionTarget } from "@/lib/missions/mission-automations";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; automationId: string }> };

const NOT_FOUND = { error: "No such automation." };

/** Change an automation, any of its fields: the org's admins may. Changing
 *  what it does makes it run as the admin who changed it. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, automationId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(automationId)) return NextResponse.json(NOT_FOUND, { status: 404 });

  const parsed = parseAutomationInput(await request.json().catch(() => null), { full: false });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingAutomation(async () => {
    const saved = await getAutomation(id, automationId);
    if (!saved) return NextResponse.json(NOT_FOUND, { status: 404 });
    const target = await checkMissionTarget(id, caller.owner.id, parsed.value, saved.target, { mission: sessionById, level: missionLevel });
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
    if (!(await updateAutomation(id, automationId, caller.owner.id, target.input))) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }
    return NextResponse.json({ id: automationId });
  });
}

/** Delete an automation: the org's admins may. */
export async function DELETE(request: Request, { params }: Params) {
  const { id, automationId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(automationId)) return NextResponse.json(NOT_FOUND, { status: 404 });
  return savingAutomation(async () => {
    if (!(await deleteAutomation(id, automationId))) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ deleted: true });
  }, "delete");
}
