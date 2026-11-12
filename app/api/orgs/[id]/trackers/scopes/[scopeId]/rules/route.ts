import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { createRule, orgScope, TrackerSettingsError } from "@/lib/db/trackers";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";
import { parseRuleInput } from "@/lib/trackers/rules";

type RouteContext = { params: Promise<{ id: string; scopeId: string }> };

/** A new triage rule on a connected team, last in its order. An admin's, who is
 *  who it files as when the issue's author isn't linked. */
export async function POST(request: Request, context: RouteContext) {
  const { id, scopeId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const scope = isUuid(scopeId) ? await orgScope(id, scopeId) : null;
  if (!scope) return NextResponse.json({ error: "That team isn't connected to this org." }, { status: 404 });
  const parsed = parseRuleInput(await request.json().catch(() => null), scope.provider, { full: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingSettings("a triage rule", async () => {
    try {
      const rule = await createRule(id, scopeId, parsed.value, caller.owner.id);
      await recordAudit({
        orgId: id,
        actor: caller.owner,
        action: "tracker.rule_changed",
        resource: { type: "integration", id: rule.id, label: scope.name ?? scope.externalTeamId },
      });
      return NextResponse.json({ rule });
    } catch (error) {
      if (error instanceof TrackerSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}
