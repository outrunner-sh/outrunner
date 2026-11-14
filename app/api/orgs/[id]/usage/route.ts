import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { entitlementsFor } from "@/lib/billing/entitlements";
import { orgUsage } from "@/lib/billing/org-standing";
import { formatUsd } from "@/lib/billing/usage";
import { postedLimitUsd, postedThreshold, takesLimit, type AlertThreshold } from "@/lib/billing/usage-controls";
import { getUsageControls, setUsageControls } from "@/lib/db/org-usage";
import { savingSettings } from "@/lib/http/settings-save";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An org's cloud usage and its admins' controls over it (Settings → Org →
 * Usage; lib/billing/usage-controls.ts), personal or team. GET, for any
 * member: the controls and where its usage stands. PUT, an admin's:
 * `{ limitUsd: number | null, alertThresholds: (50 | 80 | 100 | 150 | 200)[] }`,
 * the limit in dollars from the plan's included usage up, on a plan that
 * bills overage; on one that doesn't, the posted limit is ignored and the
 * saved one kept.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  return NextResponse.json(await orgUsage(id));
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { limitUsd?: unknown; alertThresholds?: unknown } | null;
  const { plan } = await entitlementsFor(id);
  // On a plan that takes no limit, the one saved (on a plan that did) is
  // kept as it is and ignored (limitFor), and only the alerts change: the
  // page posts the whole controls, saved limit and all, on every toggle.
  const limitUsd = takesLimit(plan)
    ? postedLimitUsd(body?.limitUsd ?? null, plan)
    : (await getUsageControls(id)).limitUsd;
  if (limitUsd === undefined) {
    return NextResponse.json(
      { error: `Set the limit in dollars and cents, from the plan's included ${formatUsd(plan.usage.includedUsd * 100)} up, or none.` },
      { status: 400 },
    );
  }
  const raw = Array.isArray(body?.alertThresholds) ? body.alertThresholds : null;
  const thresholds = raw?.map(postedThreshold);
  if (!thresholds || thresholds.some((t) => t === null)) {
    return NextResponse.json({ error: "Choose alerts at 50, 80, 100, 150 or 200%." }, { status: 400 });
  }
  const controls = { limitUsd, alertThresholds: [...new Set(thresholds as AlertThreshold[])].sort((a, b) => a - b) };
  return savingSettings("usage controls", async () => {
    await setUsageControls(id, controls, caller.owner.id);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "usage.changed",
      resource: { type: "settings", id: "usage" },
      details: { limitUsd: controls.limitUsd, alertThresholds: controls.alertThresholds },
    });
    return NextResponse.json(await orgUsage(id));
  });
}
