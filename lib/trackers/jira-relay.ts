/**
 * A session's turns back to the Jira issue that asked, as comments: watched for their end
 * (lib/trackers/turn-watch-relay.ts), right after a send and then by the tick. Jira shows no
 * session going stale, so there's no heartbeat: only what's over, lost, or asked.
 */

import {
  claimJiraQuestion,
  claimJiraReply,
  jiraRelayRow,
  jiraRepliesAwaited,
  openJiraWatch,
  releaseJiraQuestion,
  restoreJiraReply,
  saveJiraWatch,
  stopJiraRow,
} from "@/lib/db/jira-sessions";
import { orgUsesInstallation, scopeForTeam } from "@/lib/db/trackers";
import { boxSummaryLook } from "@/lib/missions/watch.deps";
import { sessionById } from "@/lib/missions/store";
import { watchUntil } from "@/lib/session/turn-watch";
import { askJira } from "@/lib/trackers/ask-jira";
import { jiraComment } from "@/lib/trackers/jira";
import { AWAIT_MS, sessionUrl } from "@/lib/trackers/linear-relay";
import { checkTurnRelay, type RelayDeps } from "@/lib/trackers/turn-watch-relay";

/** How long the send's own watch lasts before the tick takes over. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 10_000;
/** Jira refuses a comment past 32,767 characters. Left room for what follows the message. */
const MESSAGE_MAX = 30_000;

function relayDeps(installationId: string, issueId: string): RelayDeps {
  return {
    trackerName: "Jira",
    thoughtEveryMs: null,
    questionHint: "To answer, reply here and mention Outrunner.",
    messageMax: MESSAGE_MAX,
    reviveHint: "Assign or mention Outrunner again to bring it back.",
    load: () => jiraRelayRow(installationId, issueId),
    connected: async (row) => {
      if (!row.orgId) return true;
      if (row.teamId) return (await scopeForTeam(row.installationId, row.teamId))?.orgId === row.orgId;
      return orgUsesInstallation(row.orgId, row.installationId);
    },
    session: async (workspaceId) => {
      const session = await sessionById(workspaceId);
      return session ? { status: session.status, errorMessage: session.errorMessage } : null;
    },
    look: async (workspaceId) => {
      const session = await sessionById(workspaceId);
      return session ? boxSummaryLook(session) : { reachable: false, working: null, summary: null };
    },
    saveWatch: (_id, sentAt, state) => saveJiraWatch(installationId, issueId, sentAt, state),
    claimFinal: (_id, digest) => claimJiraReply(installationId, issueId, digest),
    restoreFinal: (_id, row) => restoreJiraReply(installationId, issueId, row),
    claimQuestion: (_id, digest) => claimJiraQuestion(installationId, issueId, digest),
    releaseQuestion: () => releaseJiraQuestion(installationId, issueId),
    claimThought: async () => false,
    restoreThought: async () => undefined,
    say: (_installation, _id, content) => askJira(installationId, undefined, (token, cloudId) => jiraComment(token, cloudId, issueId, content.body)),
    stop: () => stopJiraRow(installationId, issueId),
    sessionUrl,
    now: Date.now,
  };
}

/** A turn was sent: a new watch, for the tick to carry on from a restart. */
export function openJiraReplyWatch(installationId: string, issueId: string, sent: { sentAt: number; baselineActivity: number | null }): Promise<void> {
  return openJiraWatch(installationId, issueId, sent, sent.sentAt + AWAIT_MS);
}

/** Watch a while; the tick carries on after. */
export async function watchJiraReply(installationId: string, issueId: string): Promise<void> {
  await watchUntil(() => checkTurnRelay(issueId, relayDeps(installationId, issueId)), { forMs: WATCH_MS, everyMs: WATCH_EVERY_MS });
}

/** The tick's part: turns still watched. How many ended. */
export async function relayJiraAwaited(): Promise<number> {
  let done = 0;
  for (const { installationId, issueId } of await jiraRepliesAwaited()) {
    const ended = await checkTurnRelay(issueId, relayDeps(installationId, issueId)).catch((error: unknown) => {
      console.error(`Jira: couldn't relay to issue ${issueId}`, error);
      return false;
    });
    if (ended) done += 1;
  }
  return done;
}
