/** A site's Jira admin clearing whoever holds it (lib/trackers/jira-callback.ts). */

import { recordAudit } from "@/lib/audit/record";
import { installationById, installationOrgIds, loadTokenRow, markDisconnected, removeOrgFromInstallation, saveWebhook } from "@/lib/db/trackers";
import { stopJiraRowsOf } from "@/lib/db/jira-sessions";
import { jiraDeleteWebhook } from "@/lib/trackers/jira";

type Actor = Parameters<typeof recordAudit>[0]["actor"];

/** The holder's webhook goes while there's a token to remove it with; every org's teams and
 *  rules go, and items already filed stay. Each org's audit log says who did it. */
export async function evictJiraInstall(installationId: string, by: { orgId: string; ownerId: string }, actor: Actor): Promise<void> {
  const [install, row, orgIds] = await Promise.all([installationById(installationId), loadTokenRow(installationId), installationOrgIds(installationId)]);
  if (install?.webhookId != null && row?.accessToken) {
    await jiraDeleteWebhook(row.accessToken, install.externalId, install.webhookId).catch((error: unknown) => console.warn("Jira: couldn't remove the webhook of a reclaimed site", error));
  }
  await markDisconnected(installationId);
  await saveWebhook(installationId, null, null);
  for (const orgId of orgIds) {
    await stopJiraRowsOf(installationId, orgId);
    await removeOrgFromInstallation(orgId, installationId);
    await recordAudit({
      orgId,
      actor,
      action: "tracker.disconnected",
      resource: { type: "integration", id: "jira", label: "Jira" },
      details: { label: `${install?.name ?? "A site"}: reclaimed by its Jira admin` },
    });
  }
}
