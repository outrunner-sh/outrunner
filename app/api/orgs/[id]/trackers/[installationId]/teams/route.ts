import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { connectScope, installationById, orgUsesInstallation, TrackerSettingsError } from "@/lib/db/trackers";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";
import { askJira } from "@/lib/trackers/ask-jira";
import { askLinear } from "@/lib/trackers/ask-linear";
import { jiraProjectCatalog, jiraProjects } from "@/lib/trackers/jira";
import { syncJiraWebhookLogged } from "@/lib/trackers/jira-webhooks.deps";
import { linearTeamCatalog, linearTeams } from "@/lib/trackers/linear";
import { defaultStateMap } from "@/lib/trackers/rules";

type RouteContext = { params: Promise<{ id: string; installationId: string }> };

const noSuch = () => NextResponse.json({ error: "This org isn't connected to that workspace." }, { status: 404 });
const unavailable = (name: string) => NextResponse.json({ error: `${name} isn't answering. Try again.` }, { status: 502 });
const disconnected = () => NextResponse.json({ error: "This workspace is disconnected. Reconnect it first." }, { status: 409 });

/** A Jira project is the team of Linear's that everything here talks about. */
const teamsOf = (installationId: string, jira: boolean) =>
  jira
    ? askJira(installationId, null, (token, cloudId) => jiraProjects(token, cloudId))
    : askLinear(installationId, null, (token) => linearTeams(token));
const catalogOf = (installationId: string, jira: boolean, teamId: string) =>
  jira
    ? askJira(installationId, null, (token, cloudId) => jiraProjectCatalog(token, cloudId, teamId))
    : askLinear(installationId, null, (token) => linearTeamCatalog(token, teamId));

/** The workspace's teams or the site's projects, from the tracker, to connect from. An
 *  admin's: it lists every one there, which on a shared workspace includes other orgs'. */
export async function GET(request: Request, context: RouteContext) {
  const { id, installationId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(installationId) || !(await orgUsesInstallation(id, installationId))) return noSuch();
  const jira = (await installationById(installationId))?.provider === "jira";
  try {
    const teams = await teamsOf(installationId, jira);
    return teams ? NextResponse.json({ teams }) : disconnected();
  } catch (error) {
    console.error("Trackers: couldn't list teams", error);
    return unavailable(jira ? "Jira" : "Linear");
  }
}

/** Connect a team: it becomes this org's, unless another's has it. An admin's. It starts
 *  on the state map the tracker's own names suggest. A Jira site's one webhook covers it
 *  from now on. */
export async function POST(request: Request, context: RouteContext) {
  const { id, installationId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(installationId) || !(await orgUsesInstallation(id, installationId))) return noSuch();
  const body = (await request.json().catch(() => null)) as { teamId?: unknown } | null;
  const teamId = body?.teamId;
  const jira = (await installationById(installationId))?.provider === "jira";
  const name = jira ? "Jira" : "Linear";
  if (typeof teamId !== "string" || !teamId) return NextResponse.json({ error: jira ? "Pick a project." : "Pick a team." }, { status: 400 });

  let found: { name: string; states: { id: string; name: string; type: string }[] } | null;
  try {
    const team = (await teamsOf(installationId, jira))?.find((t) => t.id === teamId);
    found = team ? { name: team.name, states: (await catalogOf(installationId, jira, teamId))?.states ?? [] } : null;
  } catch (error) {
    console.error("Trackers: couldn't read a team", error);
    return unavailable(name);
  }
  if (!found) return NextResponse.json({ error: `${name} doesn't show that ${jira ? "project" : "team"} to Outrunner.` }, { status: 404 });
  const team = found;

  return savingSettings(`a ${name} ${jira ? "project" : "team"}`, async () => {
    try {
      const scope = await connectScope({
        orgId: id,
        installationId,
        externalTeamId: teamId,
        name: team.name,
        setBy: caller.owner.id,
        stateMap: defaultStateMap(team.states),
      });
      await recordAudit({
        orgId: id,
        actor: caller.owner,
        action: "tracker.team_connected",
        resource: { type: "integration", id: scope.id, label: team.name },
      });
      if (jira) await syncJiraWebhookLogged(installationId);
      return NextResponse.json({ scope });
    } catch (error) {
      if (error instanceof TrackerSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}
