/** What lib/trackers/linear-events.ts does its work with, on the server. */

import { after } from "next/server";

import { forgetAgentComment, liveRowsForIssue, stopAgentRow } from "@/lib/db/linear-agent";

import { archiveOnClose } from "@/lib/db/github-loop";
import {
  installationByExternalId,
  installationOrgIds,
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
import { askLinear } from "@/lib/trackers/ask-linear";
import { handleAgentEvent, handleRedelegated, within } from "@/lib/trackers/linear-agent";
import { agentDeps } from "@/lib/trackers/linear-agent.deps";
import { linearDuplicateOf, linearIssueCreator, linearIssueStanding, linearViewer } from "@/lib/trackers/linear";
import type { LinearEventDeps } from "@/lib/trackers/linear-events";

export const linearEventDeps: LinearEventDeps = {
  agentEvent: (installation, payload, later) => handleAgentEvent(installation, payload, { ...agentDeps, defer: later }),
  redelegated: (installation, again) => handleRedelegated(installation, again, agentDeps),
  workingTurns: async (installationId, issueId) => (await liveRowsForIssue(installationId, issueId)).filter((row) => row.stage === "working").length,
  stopDelegation: async (installationId, issueId) => {
    // Stopped first: a session still being set up is interrupted once it's up, by what's
    // starting it. A question waiting has nothing to stop, and its answer now starts nothing.
    const rows = await liveRowsForIssue(installationId, issueId);
    for (const row of rows) await stopAgentRow(row.agentSessionId);
    const working = rows.filter((row) => row.stage === "working");
    for (const row of working) {
      if (row.ownerId && row.workspaceId) await within(agentDeps.stop(row.ownerId, row.workspaceId), agentDeps.interruptWaitMs, false);
    }
  },
  installation: (externalId) => installationByExternalId("linear", externalId),
  appTokenWorks: (installationId) => askLinear(installationId, false, (token) => linearViewer(token).then(() => true)),
  eventSeen: trackerEventSeen,
  markEventSeen: markTrackerEventSeen,
  scopeForTeam,
  rulesForScope,
  orgIds: installationOrgIds,
  linkedOwner,
  triageActor: (userId, orgId) => triageActor(userId, orgId),
  item: (orgId, sourceRef) => trackerItem(orgId, "linear", sourceRef),
  itemsInOrgs: (orgIds, sourceRef) => trackerItemsInOrgs(orgIds, "linear", sourceRef),
  itemById: workItemInOrg,
  file: fileTrackerItem,
  followText: followTrackerText,
  close: closeFromTracker,
  reopen: reopenWorkItem,
  stopFollowing: stopFollowingTracker,
  addNote: addTrackerNote,
  editNote: editTrackerNote,
  deleteNote: deleteTrackerNote,
  forgetComment: forgetAgentComment,
  issueStanding: (installationId, issueId) => askLinear(installationId, null, (token) => linearIssueStanding(token, issueId)),
  issueCreator: (installationId, issueId) => askLinear(installationId, null, (token) => linearIssueCreator(token, issueId)),
  duplicateOf: (installationId, issueId) => askLinear(installationId, null, (token) => linearDuplicateOf(token, issueId)),
  session: async (workspaceId) => {
    const { data, error } = await createSupabaseAdminClient()
      .from("workspaces")
      .select("id, owner_id, status")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, ownerId: data.owner_id, status: data.status } : null;
  },
  archiveOnClose,
  wake: wakeSession,
  suspend: suspendSession,
  archiveServerSessions,
  defer: (work) =>
    after(() => work().catch((error: unknown) => console.error("Linear: follow-up work failed", error))),
};
