/** What lib/trackers/jira-webhooks.ts does its work with, on the server. */

import { installationById, saveWebhook, scopedProjects, webhooksDueForRefresh, webhooksMissing } from "@/lib/db/trackers";
import { askJira } from "@/lib/trackers/ask-jira";
import { jiraConfig, jiraDeleteWebhook, jiraRefreshWebhook, jiraRegisterWebhook } from "@/lib/trackers/jira";
import { type JiraWebhookDeps, refreshJiraWebhooks, syncJiraWebhook } from "@/lib/trackers/jira-webhooks";

const deps: JiraWebhookDeps = {
  webhookUrl: () => jiraConfig()?.webhookUrl ?? null,
  install: installationById,
  projects: scopedProjects,
  register: (id, url, projects) => askJira(id, null, (token, cloudId) => jiraRegisterWebhook(token, cloudId, url, projects)),
  remove: (id, webhookId) => askJira(id, undefined, (token, cloudId) => jiraDeleteWebhook(token, cloudId, webhookId)),
  refresh: (id, webhookId) => askJira(id, null, (token, cloudId) => jiraRefreshWebhook(token, cloudId, webhookId)),
  save: saveWebhook,
  due: webhooksDueForRefresh,
  missing: webhooksMissing,
  now: Date.now,
};

/** A settings change's part: the change has happened, and the tick repairs a miss. */
export function syncJiraWebhookLogged(installationId: string): Promise<void> {
  return syncJiraWebhook(installationId, deps).catch((error: unknown) => console.error(`Jira: couldn't update the webhook of ${installationId}`, error));
}

export function refreshAllJiraWebhooks(): Promise<number> {
  return refreshJiraWebhooks(deps);
}
