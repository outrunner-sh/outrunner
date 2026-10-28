import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOrg } from "@/lib/db/orgs";
import { getOrgDefaults, setOrgDefaults } from "@/lib/db/org-defaults";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";
import { isBoxSizeId } from "@/lib/runtime/box-sizes";
import { parseLoadoutEntry } from "@/lib/runtime/model-loadout";
import { DEFAULT_EFFORT, takesEffort } from "@/lib/runtime/session-models";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A team org's defaults for its members' new sessions (Settings → Org →
 * Defaults; lib/db/org-defaults.ts): the model one starts on, and the size of
 * a new box, for members who haven't chosen their own. GET for any member;
 * PUT, an admin's, sets both (`null` leaves one to Outrunner's own).
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json(await getOrgDefaults(id));
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if ((await getOrg(id))?.personal) {
    return NextResponse.json(
      { error: "Your personal org's defaults are your own: Settings → Default models and Sandbox." },
      { status: 409 },
    );
  }
  const body = (await request.json().catch(() => null)) as { defaultModel?: unknown; boxSize?: unknown } | null;
  const defaultModel = body?.defaultModel == null ? null : parseLoadoutEntry(body.defaultModel);
  if (body?.defaultModel != null && !defaultModel) {
    return NextResponse.json({ error: "Choose one of the models." }, { status: 400 });
  }
  if (body?.boxSize != null && !isBoxSizeId(body.boxSize)) {
    return NextResponse.json({ error: "Choose one of the box sizes." }, { status: 400 });
  }
  // A model that takes an effort starts at the usual one.
  if (defaultModel && takesEffort(defaultModel) && !defaultModel.effort) defaultModel.effort = DEFAULT_EFFORT;
  const defaults = { defaultModel, boxSize: isBoxSizeId(body?.boxSize) ? body.boxSize : null };
  return savingSettings("org defaults", async () => {
    await setOrgDefaults(id, defaults, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "defaults.changed",
      resource: { type: "settings", id: "defaults" },
      details: {
        defaultModel: defaults.defaultModel ? `${defaults.defaultModel.provider}/${defaults.defaultModel.id}` : null,
        boxSize: defaults.boxSize,
      },
    });
    return NextResponse.json(defaults);
  });
}
