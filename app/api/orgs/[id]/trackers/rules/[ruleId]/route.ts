import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { deleteRule, moveRule, orgRule, orgScope, TrackerSettingsError, updateRule } from "@/lib/db/trackers";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";
import { parseRuleInput } from "@/lib/trackers/rules";

type RouteContext = { params: Promise<{ id: string; ruleId: string }> };

const noSuch = () => NextResponse.json({ error: "No such rule." }, { status: 404 });

/** The rule, and the team it's on (its label for the audit, its tracker for the
 *  checks), or null for one that isn't this org's. */
async function ruleAndScope(orgId: string, ruleId: string) {
  if (!isUuid(ruleId)) return null;
  const rule = await orgRule(orgId, ruleId);
  const scope = rule ? await orgScope(orgId, rule.scopeId) : null;
  return rule && scope ? { rule, scope } : null;
}

/** Change a rule, or (`move`: "up" or "down") its place in the team's order. An
 *  admin's. Changing what it files takes it on; a move or a switch doesn't. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id, ruleId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const found = await ruleAndScope(id, ruleId);
  if (!found) return noSuch();
  const label = found.scope.name ?? found.scope.externalTeamId;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const audit = () =>
    recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "tracker.rule_changed",
      resource: { type: "integration", id: ruleId, label },
    });

  if (body?.move !== undefined) {
    const direction = body.move;
    if (direction !== "up" && direction !== "down") return NextResponse.json({ error: "Move it up or down." }, { status: 400 });
    return savingSettings("a triage rule's order", async () => {
      await moveRule(id, ruleId, direction);
      await audit();
      return NextResponse.json({ ok: true });
    });
  }

  const parsed = parseRuleInput(body, found.scope.provider, { full: false });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingSettings("a triage rule", async () => {
    try {
      const rule = await updateRule(id, ruleId, parsed.value, caller.owner.id);
      if (!rule) return noSuch();
      await audit();
      return NextResponse.json({ rule });
    } catch (error) {
      if (error instanceof TrackerSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}

/** Remove a rule: items it filed stay. An admin's. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, ruleId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const found = await ruleAndScope(id, ruleId);
  if (!found) return noSuch();
  return savingSettings("a triage rule", async () => {
    await deleteRule(id, ruleId);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "tracker.rule_changed",
      resource: { type: "integration", id: ruleId, label: found.scope.name ?? found.scope.externalTeamId },
    });
    return NextResponse.json({ ok: true });
  });
}
