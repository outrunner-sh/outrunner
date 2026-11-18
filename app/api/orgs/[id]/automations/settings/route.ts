import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getAutomationSettings, setAutomationSettings } from "@/lib/db/automation-settings";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An org's settings for all its automations (Settings → Org; lib/db/
 * automation-settings.ts): whether they run on their runner's default model
 * and coding agent instead of Outrunner's models. GET for any member; PUT,
 * an admin's, for a personal org as for a team's.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json(await getAutomationSettings(id));
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { onHarness?: unknown } | null;
  if (typeof body?.onHarness !== "boolean") {
    return NextResponse.json({ error: "Choose what automations run on." }, { status: 400 });
  }
  const settings = { onHarness: body.onHarness };
  return savingSettings("automation settings", async () => {
    await setAutomationSettings(id, settings, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "automations.settings_changed",
      resource: { type: "settings", id: "automations" },
      details: { automationsOnHarness: settings.onHarness },
    });
    return NextResponse.json(await getAutomationSettings(id));
  });
}
