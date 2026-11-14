/** What lib/trackers/linear-agent.ts does its work with, on the server. */

import { after } from "@/lib/observability/after";

import { agentRow, claimIssue, claimRuleSession, latestRowForIssue, releaseIssue, rowsAwaitingLink, saveAgentRow, setAgentRowWorkspace, stopAgentRow } from "@/lib/db/linear-agent";
import { listOrgProjects, projectLevel } from "@/lib/db/org-access";
import { installationById, linkedOwner, scopeForTeam } from "@/lib/db/trackers";
import { addTrackerNote, fileTrackerItem, linkTrackerItem, trackerItem, triageActor } from "@/lib/db/work-items";
import { optionalEnv } from "@/lib/env";
import { freeIssueBranch } from "@/lib/session/issue-branch";
import { startServerSession } from "@/lib/session/server-session";
import { POST as interruptPOST } from "@/app/api/workspaces/[id]/interrupt/route";
import { asBrowser, wakeAndSend } from "@/lib/slack/research";
import { actAsUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { askLinear } from "@/lib/trackers/ask-linear";
import {
  linearAddSessionUrl,
  linearAgentActivity,
  linearIssueCreator,
  linearIssueStanding,
  linearRepositorySuggestions,
  linearSetIssueState,
} from "@/lib/trackers/linear";
import { type AgentDeps, resumeAfterLink } from "@/lib/trackers/linear-agent";
import { linearSendBaseline, openLinearWatch, sessionUrl, watchLinearReply } from "@/lib/trackers/linear-relay";

/** How long a delegation waits for its person to link. */
const LINK_WAIT_MS = 24 * 60 * 60_000;

export const agentDeps: AgentDeps = {
  // A token that can't be had right now throws: the webhook answers 503, and Linear
  // delivers it again. A disconnected install has no one to say anything to.
  say: (installationId, agentSessionId, content, signal) =>
    askLinear(installationId, undefined, (token) => linearAgentActivity(token, agentSessionId, content, signal)),
  addUrl: (installationId, agentSessionId, url) => askLinear(installationId, undefined, (token) => linearAddSessionUrl(token, agentSessionId, url)),
  setIssueState: (installationId, issueId, stateId) => askLinear(installationId, undefined, (token) => linearSetIssueState(token, issueId, stateId)),
  standing: (installationId, issueId) => askLinear(installationId, null, (token) => linearIssueStanding(token, issueId)),
  creator: (installationId, issueId) => askLinear(installationId, null, (token) => linearIssueCreator(token, issueId)),
  suggestions: (installationId, issueId, agentSessionId, repositories) =>
    askLinear(installationId, [], (token) => linearRepositorySuggestions(token, issueId, agentSessionId, repositories)),
  scopeForTeam,
  claimRuleSession,
  linkedOwner,
  triageActor: (userId, orgId) => triageActor(userId, orgId),
  projects: listOrgProjects,
  level: projectLevel,
  item: (orgId, sourceRef) => trackerItem(orgId, "linear", sourceRef),
  file: fileTrackerItem,
  linkItem: linkTrackerItem,
  addNote: addTrackerNote,
  row: agentRow,
  latestRow: latestRowForIssue,
  saveRow: saveAgentRow,
  setRowWorkspace: setAgentRowWorkspace,
  stopRow: stopAgentRow,
  claimIssue,
  releaseIssue,
  session: async (workspaceId) => {
    const { data, error } = await createSupabaseAdminClient().from("workspaces").select("id, owner_id, project_id, status").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, ownerId: data.owner_id, projectId: data.project_id, status: data.status } : null;
  },
  start: startServerSession,
  send: (ownerId, workspaceId, text) => wakeAndSend(ownerId, workspaceId, text, "linear"),
  stop: (ownerId, workspaceId) =>
    actAsUser(ownerId, async () => {
      const response = await interruptPOST(asBrowser(`/api/workspaces/${workspaceId}/interrupt`, {}), { params: Promise.resolve({ id: workspaceId }) });
      return response.ok;
    }),
  branchFor: (projectId, key, title) => freeIssueBranch(projectId, { source: "linear", key }, title),
  interruptWaitMs: 3000,
  sendBaseline: linearSendBaseline,
  openWatch: openLinearWatch,
  watchReply: watchLinearReply,
  now: Date.now,
  linkUrl: () => new URL("/api/integrations/linear/link", optionalEnv("RUNTIME_BASE_URL") ?? "http://localhost").toString(),
  sessionUrl,
  defer: (work) => after(() => work().catch((error: unknown) => console.error("Linear: delegation work failed", error))),
};

/** Someone just linked: what they asked for carries on, without their asking again. */
export async function resumeLinkedDelegations(installationId: string, externalUserId: string): Promise<void> {
  const installation = await installationById(installationId);
  if (!installation) return;
  for (const row of await rowsAwaitingLink(installationId, externalUserId, Date.now() - LINK_WAIT_MS)) {
    await resumeAfterLink(installation, row, agentDeps).catch((error: unknown) => console.error(`Linear: couldn't carry on ${row.agentSessionId} after a link`, error));
  }
}
