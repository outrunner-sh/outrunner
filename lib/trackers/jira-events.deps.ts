/** What lib/trackers/jira-events.ts does its work with, on the server. */

import { after } from "@/lib/observability/after";

import { archiveOnClose } from "@/lib/db/github-loop";
import { forgetJiraComment, jiraRow, stopJiraRow } from "@/lib/db/jira-sessions";
import {
  installationOrgIds,
  jiraInstallationOf,
  linkedOwner,
  markTrackerEventSeen,
  rulesForScope,
  scopeForTeam,
  trackerEventSeen,
} from "@/lib/db/trackers";
import {
  addTrackerNote,
  closeFromTracker,
  deleteTrackerNote,
  editTrackerNote,
  fileTrackerItem,
  followTrackerText,
  reopenWorkItem,
  stopFollowingTracker,
  trackerItem,
  trackerItemsInOrgs,
  triageActor,
  workItemInOrg,
} from "@/lib/db/work-items";
import { archiveServerSessions } from "@/lib/session/server-session";
import { suspendSession, wakeSession } from "@/lib/slack/research";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { askJira } from "@/lib/trackers/ask-jira";
import { jiraIssueStanding, jiraStatusType } from "@/lib/trackers/jira";
import { handleJiraTrigger } from "@/lib/trackers/jira-agent";
import { jiraAgentDeps } from "@/lib/trackers/jira-agent.deps";
import type { JiraEventDeps } from "@/lib/trackers/jira-events";
import { within } from "@/lib/trackers/linear-agent";

/** How long an unassign waits on the session: Jira is waiting on the webhook's answer. */
const STOP_WAIT_MS = 3000;

export const jiraEventDeps: JiraEventDeps = {
  forgetComment: forgetJiraComment,
  installation: jiraInstallationOf,
  eventSeen: trackerEventSeen,
  markEventSeen: markTrackerEventSeen,
  scopeForTeam,
  rulesForScope,
  orgIds: installationOrgIds,
  linkedOwner,
  triageActor: (userId, orgId) => triageActor(userId, orgId),
  item: (orgId, sourceRef) => trackerItem(orgId, "jira", sourceRef),
  itemsInOrgs: (orgIds, sourceRef) => trackerItemsInOrgs(orgIds, "jira", sourceRef),
  itemById: workItemInOrg,
  file: fileTrackerItem,
  followText: followTrackerText,
  close: closeFromTracker,
  reopen: reopenWorkItem,
  stopFollowing: stopFollowingTracker,
  addNote: addTrackerNote,
  editNote: editTrackerNote,
  deleteNote: deleteTrackerNote,
  issueStanding: (installationId, issueId) => askJira(installationId, null, (token, cloudId) => jiraIssueStanding(token, cloudId, issueId)),
  statusType: (installationId, statusId) => askJira(installationId, null, (token, cloudId) => jiraStatusType(token, cloudId, statusId)),
  session: async (workspaceId) => {
    const { data, error } = await createSupabaseAdminClient().from("workspaces").select("id, owner_id, status").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, ownerId: data.owner_id, status: data.status } : null;
  },
  archiveOnClose,
  wake: wakeSession,
  suspend: suspendSession,
  archiveServerSessions,
  trigger: (installation, trigger) => {
    after(() => handleJiraTrigger(installation, trigger, jiraAgentDeps).catch((error: unknown) => console.error("Jira: delegation work failed", error)));
  },
  workingTurns: async (installationId, issueId) => ((await jiraRow(installationId, issueId))?.stage === "working" ? 1 : 0),
  stopDelegation: async (installationId, issueId) => {
    const row = await jiraRow(installationId, issueId);
    // Stopped first, always: what's deciding has a row that only reads as stopped, and a new
    // mark is how it finds out. A session still being set up is interrupted once it's up.
    await stopJiraRow(installationId, issueId);
    if (row?.stage === "working" && row.ownerId && row.workspaceId) await within(jiraAgentDeps.stop(row.ownerId, row.workspaceId), STOP_WAIT_MS, false);
  },
  defer: (work) => after(() => work().catch((error: unknown) => console.error("Jira: follow-up work failed", error))),
};
