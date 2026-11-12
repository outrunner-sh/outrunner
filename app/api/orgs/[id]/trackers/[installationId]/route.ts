import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { installationById, installationOrgIds, loadTokenRow, markDisconnected, removeOrgFromInstallation, saveWebhook } from "@/lib/db/trackers";
import { savingSettings } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { stopJiraRowsOf } from "@/lib/db/jira-sessions";
import { stopAgentRowsOf } from "@/lib/db/linear-agent";
import { orgCaller } from "@/lib/orgs/routes";
import { disconnectOrgFromWorkspace } from "@/lib/trackers/disconnect";
import { jiraDeleteWebhook } from "@/lib/trackers/jira";
import { syncJiraWebhookLogged } from "@/lib/trackers/jira-webhooks.deps";
import { revokeLinearToken } from "@/lib/trackers/linear";

type RouteContext = { params: Promise<{ id: string; installationId: string }> };

/**
 * The org stops using a Linear workspace or Jira site: its teams and rules go with it,
 * and items already filed stay. An admin's. Another org that uses it keeps it, and a Jira
 * site's webhook narrows to what's left. With none left, the token is handed back to
 * Linear. Jira has no call for that: its webhook goes, and the service account's grant
 * stays until someone removes it in Atlassian.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, installationId } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const noSuch = () => NextResponse.json({ error: "No such connection." }, { status: 404 });
  if (!isUuid(installationId)) return noSuch();
  const install = await installationById(installationId);
  const jira = install?.provider === "jira";
  const label = jira ? "Jira" : "Linear";
  return savingSettings(`the org's ${label} connection`, async () => {
    const disconnected = await disconnectOrgFromWorkspace(id, installationId, {
      removeOrg: removeOrgFromInstallation,
      orgIds: installationOrgIds,
      load: loadTokenRow,
      markDisconnected,
      revoke: async (token) => {
        if (!jira) return revokeLinearToken(token);
        // Marked disconnected already: a webhook left behind runs out by itself.
        if (install?.webhookId != null) {
          await jiraDeleteWebhook(token, install.externalId, install.webhookId).catch((error: unknown) => console.warn("Jira: couldn't remove a webhook", error));
        }
        await saveWebhook(installationId, null, null);
      },
      audit: () =>
        recordAudit({
          orgId: id,
          actor: caller.owner,
          action: "tracker.disconnected",
          resource: { type: "integration", id: label.toLowerCase(), label },
        }),
    });
    if (!disconnected) return noSuch();
    // Sessions it started keep running, as anyone's do, but tell it nothing more.
    await (jira ? stopJiraRowsOf : stopAgentRowsOf)(installationId, id);
    if (jira && (await installationOrgIds(installationId)).length > 0) await syncJiraWebhookLogged(installationId);
    return NextResponse.json({ ok: true });
  });
}
