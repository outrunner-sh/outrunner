import { NextResponse } from "next/server";

import { missionCaller } from "@/lib/missions/trigger-routes";
import { savingAutomation } from "@/lib/automations/routes";
import { parseAutomationInput } from "@/lib/automations/rules";
import { deleteAutomation, getAutomation, resetDelegation, setDelegation, updateAutomation } from "@/lib/db/automations";
import { isUuid } from "@/lib/ids";
import { changesWhatItSends, checkMissionTarget } from "@/lib/missions/mission-automations";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";

type RouteContext = { params: Promise<{ id: string; automationId: string }> };

const NOT_FOUND = { error: "No such trigger on this Mission." };

/** One of the Mission's triggers, if it is one. */
async function triggerOf(orgId: string, missionId: string, automationId: string) {
  if (!isUuid(automationId)) return null;
  const automation = await getAutomation(orgId, automationId);
  return automation?.target.kind === "mission" && automation.target.missionId === missionId ? automation : null;
}

/**
 * Change a trigger (write on the Mission's project), or, the Mission's
 * owner only, approve it sending the Mission work or revoke that
 * (`{ approved: true | false }`).
 */
export async function PATCH(request: Request, context: RouteContext) {
  const { automationId } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const approving = typeof body?.approved === "boolean" && Object.keys(body).length === 1;
  const caller = await missionCaller(request, context, approving ? "read" : "write");
  if (caller instanceof Response) return caller;
  const automation = await triggerOf(caller.mission.orgId, caller.mission.id, automationId);
  if (!automation) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (approving) {
    if (!caller.isOwner) return NextResponse.json({ error: "Only the Mission's owner approves what sends it work." }, { status: 403 });
    if (!(await setDelegation(automationId, caller.mission.id, caller.userId, body?.approved === true))) {
      return NextResponse.json({ error: "There's no approval to revoke." }, { status: 404 });
    }
    return NextResponse.json({ id: automationId, approved: body?.approved === true });
  }
  const { target: _sent, projectIds: _ignored, ...rest } = body ?? {};
  void _sent;
  void _ignored;
  const parsed = parseAutomationInput(
    { ...rest, ...(body?.target !== undefined && { target: { ...(body.target as object), kind: "mission", missionId: caller.mission.id } }) },
    { full: false },
  );
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingAutomation(async () => {
    const checked = await checkMissionTarget(caller.mission.orgId, caller.userId, parsed.value, automation.target, { mission: sessionById, level: missionLevel });
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
    // Someone else changing what it sends: the owner approves it again.
    // Withdrawn first, so no run goes under the old approval with the new config.
    if (!caller.isOwner && changesWhatItSends(checked.input)) await resetDelegation(automationId);
    if (!(await updateAutomation(caller.mission.orgId, automationId, caller.userId, checked.input))) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ id: automationId });
  });
}

/** Delete a trigger: write on the Mission's project. */
export async function DELETE(request: Request, context: RouteContext) {
  const { automationId } = await context.params;
  const caller = await missionCaller(request, context, "write");
  if (caller instanceof Response) return caller;
  if (!(await triggerOf(caller.mission.orgId, caller.mission.id, automationId))) return NextResponse.json(NOT_FOUND, { status: 404 });
  return savingAutomation(async () => {
    if (!(await deleteAutomation(caller.mission.orgId, automationId))) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ deleted: true });
  }, "delete");
}
