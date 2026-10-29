import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOrg } from "@/lib/db/orgs";
import { getOrgDefaults, setOrgDefaults } from "@/lib/db/org-defaults";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";
import { isBoxSizeId } from "@/lib/runtime/box-sizes";
import { parseLoadoutEntry } from "@/lib/runtime/model-loadout";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A team org's defaults for its members' new sessions (Settings → Org →
 * Defaults; lib/db/org-defaults.ts): the model one starts on, and the size of
 * a new box, for members who haven't chosen their own; and whether a session
 * is archived when its issue or pull request closes. GET for any member;
 * PUT, an admin's, sets the first two (`null` leaves one to Outrunner's own),
 * and archiving on close when it's sent.
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
  const body = (await request.json().catch(() => null)) as
    | { defaultModel?: unknown; boxSize?: unknown; archiveOnClose?: unknown }
    | null;
  const defaultModel = body?.defaultModel == null ? null : parseLoadoutEntry(body.defaultModel);
  if (body?.defaultModel != null && !defaultModel) {
    return NextResponse.json({ error: "Choose one of the models." }, { status: 400 });
  }
  if (body?.boxSize != null && !isBoxSizeId(body.boxSize)) {
    return NextResponse.json({ error: "Choose one of the box sizes." }, { status: 400 });
  }
  if (body?.archiveOnClose !== undefined && typeof body.archiveOnClose !== "boolean") {
    return NextResponse.json({ error: "Archiving on close is on or off." }, { status: 400 });
  }
  const defaults = {
    defaultModel,
    boxSize: isBoxSizeId(body?.boxSize) ? body.boxSize : null,
    archiveOnClose: typeof body?.archiveOnClose === "boolean" ? body.archiveOnClose : undefined,
  };
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
        ...(defaults.archiveOnClose !== undefined && { archiveOnClose: defaults.archiveOnClose }),
      },
    });
    return NextResponse.json(await getOrgDefaults(id));
  });
}
