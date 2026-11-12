import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { connectOrgToInstallation, installationByExternalId, installationOrgIds, orgUsesInstallation, saveInstallation, saveTrackerLink } from "@/lib/db/trackers";
import { appUrl } from "@/lib/orgs/notify";
import { resumeLinkedJiraDelegations } from "@/lib/trackers/jira-agent.deps";
import { exchangeJiraCode, JIRA_COOKIE_PATH, JIRA_NONCE_COOKIE, jiraConfig, jiraIsSiteAdmin, jiraMe, jiraSites, verifyJiraState } from "@/lib/trackers/jira";
import { jiraCallback } from "@/lib/trackers/jira-callback";
import { evictJiraInstall } from "@/lib/trackers/jira-evict.deps";
import { syncJiraWebhookLogged } from "@/lib/trackers/jira-webhooks.deps";

/** Where Atlassian's OAuth comes back to: lib/trackers/jira-callback.ts decides. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const config = jiraConfig();
  const jar = await cookies();
  const nonce = jar.get(JIRA_NONCE_COOKIE)?.value;
  // Used once, whatever happens next.
  jar.set(JIRA_NONCE_COOKIE, "", { path: JIRA_COOKIE_PATH, maxAge: 0 });

  const state = config ? verifyJiraState(url.searchParams.get("state"), config.clientSecret) : null;
  const back = (result: string, kind = state?.kind, siteId?: string) =>
    NextResponse.redirect(appUrl(`${kind === "link" ? "/settings/integrations" : "/settings/org/jira"}?jira=${result}${siteId ? `&site=${encodeURIComponent(siteId)}` : ""}`, origin), { status: 303 });
  if (!config) return back("unavailable");

  let actor: Awaited<ReturnType<typeof getOwner>> = null;
  const { result, kind, siteId } = await jiraCallback(
    { state, nonce, code: url.searchParams.get("code"), error: url.searchParams.get("error") },
    {
      ownerId: async () => {
        actor = await getOwner();
        return actor?.id ?? null;
      },
      memberRole,
      exchange: (code) => exchangeJiraCode(config, code),
      sites: (token) => jiraSites(token),
      me: (token) => jiraMe(token),
      installation: (siteId) => installationByExternalId("jira", siteId),
      orgUses: orgUsesInstallation,
      orgIds: installationOrgIds,
      saveInstall: ({ site, me, tokens, ownerId }) =>
        saveInstallation({ provider: "jira", externalId: site.id, siteUrl: site.url, name: site.name, appUserId: me.accountId, appUserName: me.name, tokens, installedBy: ownerId }),
      connectOrg: connectOrgToInstallation,
      audit: (orgId, site) =>
        recordAudit({
          orgId,
          actor: actor as NonNullable<typeof actor>,
          action: "tracker.connected",
          resource: { type: "integration", id: "jira", label: "Jira" },
          details: { label: site.name ?? site.id },
        }),
      syncWebhook: syncJiraWebhookLogged,
      isSiteAdmin: (token, id) => jiraIsSiteAdmin(token, id),
      evict: (installationId, by) => evictJiraInstall(installationId, by, actor as NonNullable<typeof actor>),
      saveLink: ({ installationId, accountId, name, ownerId }) => saveTrackerLink({ installationId, externalUserId: accountId, externalName: name, ownerId }),
      resumeLinked: (installationId, accountId) =>
        after(() => resumeLinkedJiraDelegations(installationId, accountId).catch((error: unknown) => console.error("Jira: couldn't carry on after a link", error))),
    },
  );
  return back(result, kind, siteId);
}
