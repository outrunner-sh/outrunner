import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { deleteScope, orgScope, TrackerSettingsError, updateScope } from "@/lib/db/trackers";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { stopJiraRowsOf } from "@/lib/db/jira-sessions";
import { stopAgentRowsOf } from "@/lib/db/linear-agent";
import { orgCaller } from "@/lib/orgs/routes";
import { askJira } from "@/lib/trackers/ask-jira";
import { askLinear } from "@/lib/trackers/ask-linear";
import { jiraProjectCatalog } from "@/lib/trackers/jira";
import { syncJiraWebhookLogged } from "@/lib/trackers/jira-webhooks.deps";
import { linearTeamCatalog } from "@/lib/trackers/linear";
import { parseScopeSettings } from "@/lib/trackers/rules";

type RouteContext = { params: Promise<{ id: string; scopeId: string }> };

const noSuch = () => NextResponse.json({ error: "That team isn't connected to this org." }, { status: 404 });

/** What this team's rules pick from, from the tracker: its states, labels and people, and
 *  Jira's priorities and issue types. Any member, who sees the rules too. */
export async function GET(request: Request, context: RouteContext) {
  const { id, scopeId } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  const scope = isUuid(scopeId) ? await orgScope(id, scopeId) : null;
  if (!scope) return noSuch();
  const jira = scope.provider === "jira";
  const name = jira ? "Jira" : "Linear";
  try {
    const catalog = jira
      ? await askJira(scope.installationId, "disconnected" as const, (token, cloudId) => jiraProjectCatalog(token, cloudId, scope.externalTeamId))
      : await askLinear(scope.installationId, "disconnected" as const, (token) => linearTeamCatalog(token, scope.externalTeamId));
    if (catalog === "disconnected") return NextResponse.json({ error: "This workspace is disconnected. Reconnect it first." }, { status: 409 });
    return catalog
      ? NextResponse.json({ catalog })
      : NextResponse.json({ error: `${name} doesn't show this ${jira ? "project" : "team"} to Outrunner.` }, { status: 404 });
  } catch (error) {
    console.error("Trackers: couldn't read a team's catalog", error);
    return NextResponse.json({ error: `${name} isn't answering. Try again.` }, { status: 502 });
  }
}

/** A connected team's settings: its default repository, state map, and whether
 *  and how many sessions the tracker's rules may start. Only the org's admins, as
 *  those sessions spend members' accounts. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id, scopeId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(scopeId)) return noSuch();
  const parsed = parseScopeSettings(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return savingSettings("a tracker team's settings", async () => {
    try {
      const scope = await updateScope(id, scopeId, parsed.value);
      if (!scope) return noSuch();
      await recordAudit({
        orgId: id,
        actor: caller.owner,
        action: "tracker.team_changed",
        resource: { type: "integration", id: scope.id, label: scope.name ?? scope.externalTeamId },
        details: { ...parsed.value },
      });
      return NextResponse.json({ scope });
    } catch (error) {
      if (error instanceof TrackerSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}

/** Disconnect a team: its rules go, and items already filed stay. An admin's. A Jira site's
 *  webhook stops covering it. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, scopeId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const scope = isUuid(scopeId) ? await orgScope(id, scopeId) : null;
  if (!scope) return noSuch();
  return savingSettings("a tracker team", async () => {
    await deleteScope(id, scopeId);
    await (scope.provider === "jira" ? stopJiraRowsOf : stopAgentRowsOf)(scope.installationId, id, scope.externalTeamId);
    if (scope.provider === "jira") await syncJiraWebhookLogged(scope.installationId);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "tracker.team_disconnected",
      resource: { type: "integration", id: scope.id, label: scope.name ?? scope.externalTeamId },
    });
    return NextResponse.json({ ok: true });
  });
}
