/** What lib/trackers/jira-agent.ts does its work with, on the server. */

import { POST as interruptPOST } from "@/app/api/workspaces/[id]/interrupt/route";
import { claimJiraIssue, jiraRow, jiraRowsAwaitingLink, releaseJiraIssue, saveJiraRow, setJiraRowWorkspace, stopJiraRow } from "@/lib/db/jira-sessions";
import { claimRuleSession } from "@/lib/db/linear-agent";
import { listOrgProjects, projectLevel } from "@/lib/db/org-access";
import { installationById, linkedOwner, scopeForTeam } from "@/lib/db/trackers";
import { addTrackerNote, fileTrackerItem, linkTrackerItem, trackerItem, triageActor } from "@/lib/db/work-items";
import { optionalEnv } from "@/lib/env";
import { startServerSession } from "@/lib/session/server-session";
import { asBrowser, wakeAndSend } from "@/lib/slack/research";
import { actAsUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { askJira } from "@/lib/trackers/ask-jira";
import { jiraComment, jiraIssueStanding, jiraRemoteLink, jiraTransition } from "@/lib/trackers/jira";
import { type JiraAgentDeps, resumeJiraAfterLink } from "@/lib/trackers/jira-agent";
import { openJiraReplyWatch, watchJiraReply } from "@/lib/trackers/jira-relay";
import { linearSendBaseline, sessionUrl } from "@/lib/trackers/linear-relay";

/** How long a delegation waits for its person to link. */
const LINK_WAIT_MS = 24 * 60 * 60_000;

export const jiraAgentDeps: JiraAgentDeps = {
  comment: (installationId, issueId, body) => askJira(installationId, undefined, (token, cloudId) => jiraComment(token, cloudId, issueId, body)),
  remoteLink: (installationId, issueId, url, title) => askJira(installationId, undefined, (token, cloudId) => jiraRemoteLink(token, cloudId, issueId, url, title)),
  transition: (installationId, issueId, statusId) => askJira(installationId, true, (token, cloudId) => jiraTransition(token, cloudId, issueId, statusId)),
  standing: (installationId, issueId) => askJira(installationId, null, (token, cloudId) => jiraIssueStanding(token, cloudId, issueId)),
  scopeForTeam,
  claimRuleSession,
  linkedOwner,
  triageActor: (userId, orgId) => triageActor(userId, orgId),
  projects: listOrgProjects,
  level: projectLevel,
  item: (orgId, sourceRef) => trackerItem(orgId, "jira", sourceRef),
  file: fileTrackerItem,
  linkItem: linkTrackerItem,
  addNote: addTrackerNote,
  row: jiraRow,
  saveRow: saveJiraRow,
  setRowWorkspace: setJiraRowWorkspace,
  stopRow: stopJiraRow,
  claim: (installationId, issueId) => claimJiraIssue(installationId, issueId),
  release: releaseJiraIssue,
  session: async (workspaceId) => {
    const { data, error } = await createSupabaseAdminClient().from("workspaces").select("id, owner_id, project_id, status").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, ownerId: data.owner_id, projectId: data.project_id, status: data.status } : null;
  },
  start: startServerSession,
  send: (ownerId, workspaceId, text) => wakeAndSend(ownerId, workspaceId, text, "jira"),
  stop: (ownerId, workspaceId) =>
    actAsUser(ownerId, async () => {
      const response = await interruptPOST(asBrowser(`/api/workspaces/${workspaceId}/interrupt`, {}), { params: Promise.resolve({ id: workspaceId }) });
      return response.ok;
    }),
  sendBaseline: linearSendBaseline,
  openWatch: openJiraReplyWatch,
  watchReply: watchJiraReply,
  now: Date.now,
  linkUrl: () => new URL("/api/integrations/jira/link", optionalEnv("RUNTIME_BASE_URL") ?? "http://localhost").toString(),
  sessionUrl,
};

/** Someone just linked: what they asked for carries on, without their asking again. */
export async function resumeLinkedJiraDelegations(installationId: string, externalUserId: string): Promise<void> {
  const installation = await installationById(installationId);
  if (!installation) return;
  for (const row of await jiraRowsAwaitingLink(installationId, externalUserId, Date.now() - LINK_WAIT_MS)) {
    await resumeJiraAfterLink(installation, row, jiraAgentDeps).catch((error: unknown) => console.error(`Jira: couldn't carry on issue ${row.issueId} after a link`, error));
  }
}
