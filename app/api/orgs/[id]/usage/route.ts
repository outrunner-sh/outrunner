import { NextResponse } from "next/server";

import { orgHours } from "@/lib/billing/org-hours";
import { postedLimit, postedThreshold, type AlertThreshold } from "@/lib/billing/usage-controls";
import { getOrg } from "@/lib/db/orgs";
import { getUsageControls, setUsageControls } from "@/lib/db/org-usage";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A team org's cloud usage and its admins' controls over it (Settings → Org
 * → Usage; lib/billing/usage-controls.ts). GET, for any member: the controls
 * and where its hours stand. PUT, an admin's: `{ limitPercent: 10..100 |
 * null, alertThresholds: (50 | 80 | 100)[] }`.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  const controls = await getUsageControls(id);
  return NextResponse.json({ controls, hours: await orgHours(id, controls) });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if ((await getOrg(id))?.personal) {
    return NextResponse.json({ error: "Usage controls are for team orgs." }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as { limitPercent?: unknown; alertThresholds?: unknown } | null;
  const limitPercent = postedLimit(body?.limitPercent ?? null);
  if (limitPercent === undefined) {
    return NextResponse.json({ error: "Set the limit as a whole percent from 10 to 100, or none." }, { status: 400 });
  }
  const raw = Array.isArray(body?.alertThresholds) ? body.alertThresholds : null;
  const thresholds = raw?.map(postedThreshold);
  if (!thresholds || thresholds.some((t) => t === null)) {
    return NextResponse.json({ error: "Choose alerts at 50, 80 or 100%." }, { status: 400 });
  }
  const controls = { limitPercent, alertThresholds: [...new Set(thresholds as AlertThreshold[])].sort((a, b) => a - b) };
  return savingSettings("usage controls", async () => {
    await setUsageControls(id, controls, caller.owner.id);
    return NextResponse.json({ controls, hours: await orgHours(id, controls) });
  });
}
