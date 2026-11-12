/** What lib/trackers/write-back.ts does its work with, on the server, and the calls
 *  the routes make: each best effort, as the change here has already happened. An item
 *  follows one tracker, so the other's deps find nothing to do. */

import { rowsForWorkspace } from "@/lib/db/linear-agent";
import { jiraRowsForWorkspace } from "@/lib/db/jira-sessions";
import { scopeForTeam } from "@/lib/db/trackers";
import { addTrackerNote, closeFromTracker, trackerFollowing, trackersOfSession } from "@/lib/db/work-items";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { askJira } from "@/lib/trackers/ask-jira";
import { askLinear } from "@/lib/trackers/ask-linear";
import { jiraComment, jiraIssueStanding, jiraRemoteLink, jiraTransition } from "@/lib/trackers/jira";
import { linearAddSessionUrl, linearAttachLink, linearComment, linearIssueStanding, linearSetIssueState } from "@/lib/trackers/linear";
import { sessionUrl } from "@/lib/trackers/linear-relay";
import { declinedHere, type PullRequestChange, pullRequestsChanged, sessionStartedHere, type WriteBackDeps } from "@/lib/trackers/write-back";

const shared = {
  pullRequestUrl: async (workspaceId: string, projectId: string, number: number) => {
    const { data, error } = await createSupabaseAdminClient().from("pull_requests").select("url").eq("workspace_id", workspaceId).eq("project_id", projectId).eq("github_number", number).maybeSingle();
    if (error) throw error;
    return data?.url ?? null;
  },
  scopeForTeam,
  close: closeFromTracker,
  addNote: addTrackerNote,
  sessionUrl,
};

const linearDeps: WriteBackDeps = {
  ...shared,
  itemById: (itemId) => trackerFollowing(itemId, "linear"),
  itemsOfSession: (workspaceId) => trackersOfSession(workspaceId, "linear"),
  rowsOfSession: rowsForWorkspace,
  comment: (installationId, issueId, body) => askLinear(installationId, undefined, (token) => linearComment(token, issueId, body)),
  attach: (installationId, issueId, url, title) => askLinear(installationId, undefined, (token) => linearAttachLink(token, issueId, url, title)),
  addUrl: (installationId, agentSessionId, url) => askLinear(installationId, undefined, (token) => linearAddSessionUrl(token, agentSessionId, url)),
  setIssueState: (installationId, issueId, stateId) => askLinear(installationId, undefined, (token) => linearSetIssueState(token, issueId, stateId)),
  standing: (installationId, issueId) => askLinear(installationId, null, (token) => linearIssueStanding(token, issueId)),
};

const jiraDeps: WriteBackDeps = {
  ...shared,
  itemById: (itemId) => trackerFollowing(itemId, "jira"),
  itemsOfSession: (workspaceId) => trackersOfSession(workspaceId, "jira"),
  rowsOfSession: async (workspaceId) => (await jiraRowsForWorkspace(workspaceId)).map((row) => ({ agentSessionId: row.issueId, issueId: row.issueId, stage: row.stage })),
  comment: (installationId, issueId, body) => askJira(installationId, undefined, (token, cloudId) => jiraComment(token, cloudId, issueId, body)),
  attach: (installationId, issueId, url, title) => askJira(installationId, undefined, (token, cloudId) => jiraRemoteLink(token, cloudId, issueId, url, title)),
  // Jira's row is the issue, and its only place for a link is the issue's.
  addUrl: (installationId, issueId, url) => askJira(installationId, undefined, (token, cloudId) => jiraRemoteLink(token, cloudId, issueId, url.url, url.label)),
  setIssueState: async (installationId, issueId, statusId) => {
    // A workflow may offer no way there from where the issue is: then it stays.
    const moved = await askJira(installationId, true, (token, cloudId) => jiraTransition(token, cloudId, issueId, statusId));
    if (!moved) console.warn(`Jira: no transition to status ${statusId} from where issue ${issueId} is`);
  },
  standing: (installationId, issueId) => askJira(installationId, null, (token, cloudId) => jiraIssueStanding(token, cloudId, issueId)),
};

const logged = (what: string) => (error: unknown) => console.error(`Trackers: couldn't ${what}`, error);

export async function tellTrackersDeclined(itemId: string): Promise<void> {
  await declinedHere(itemId, linearDeps).catch(logged("comment on a decline in Linear"));
  await declinedHere(itemId, jiraDeps).catch(logged("comment on a decline in Jira"));
}

export async function tellTrackersSessionStarted(orgId: string, itemId: string, startedBy: string, workspaceId: string): Promise<void> {
  await sessionStartedHere(orgId, itemId, startedBy, workspaceId, linearDeps).catch(logged("comment on a session started in Linear"));
  await sessionStartedHere(orgId, itemId, startedBy, workspaceId, jiraDeps).catch(logged("comment on a session started in Jira"));
}

export async function tellTrackersPullRequests(changes: readonly PullRequestChange[]): Promise<void> {
  await pullRequestsChanged(changes, linearDeps).catch(logged("pass on pull requests to Linear"));
  await pullRequestsChanged(changes, jiraDeps).catch(logged("pass on pull requests to Jira"));
}
