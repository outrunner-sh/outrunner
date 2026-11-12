/**
 * A session's turns back to the Linear agent session that asked: watched for their end
 * (lib/trackers/turn-watch-relay.ts), right after a send and then by the tick, so a restart or
 * the box sleeping loses nothing.
 */

import { boxSummaryLook, eventAtOf } from "@/lib/missions/watch.deps";
import { sessionById } from "@/lib/missions/store";
import {
  agentRelayRow,
  agentRepliesAwaited,
  claimAgentQuestion,
  claimAgentReply,
  claimAgentThought,
  openAgentWatch,
  releaseAgentQuestion,
  restoreAgentReply,
  restoreAgentThought,
  saveAgentWatch,
  stopAgentRow,
} from "@/lib/db/linear-agent";
import { orgUsesInstallation, scopeForTeam } from "@/lib/db/trackers";
import { optionalEnv } from "@/lib/env";
import { watchUntil } from "@/lib/session/turn-watch";
import { askLinear } from "@/lib/trackers/ask-linear";
import { linearAgentActivity } from "@/lib/trackers/linear";
import { checkTurnRelay, type RelayDeps, THOUGHT_EVERY_MS } from "@/lib/trackers/turn-watch-relay";

/** How long a turn is watched after a send. A long one, as the watch knows a dead or stuck
 *  session by itself: this is only for one that never ends. */
export const AWAIT_MS = 24 * 60 * 60_000;
/** How long the send's own watch lasts before the tick takes over. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 10_000;

export function sessionUrl(workspaceId: string): string {
  const base = optionalEnv("RUNTIME_BASE_URL") ?? "";
  return `${base.replace(/\/$/, "")}/workspaces/${workspaceId}`;
}

const relayDeps: RelayDeps = {
  trackerName: "Linear",
  thoughtEveryMs: THOUGHT_EVERY_MS,
  questionHint: null,
  messageMax: null,
  reviveHint: "Delegate the issue again to bring it back.",
  load: agentRelayRow,
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
  saveWatch: saveAgentWatch,
  claimFinal: claimAgentReply,
  restoreFinal: restoreAgentReply,
  claimQuestion: claimAgentQuestion,
  releaseQuestion: releaseAgentQuestion,
  claimThought: claimAgentThought,
  restoreThought: restoreAgentThought,
  say: (installationId, agentSessionId, content) => askLinear(installationId, undefined, (token) => linearAgentActivity(token, agentSessionId, content)),
  stop: stopAgentRow,
  sessionUrl,
  now: Date.now,
};

/** Where the session's conversation last was, before a send: activity after it is that
 *  send's turn. */
export async function linearSendBaseline(workspaceId: string): Promise<number | null> {
  const session = await sessionById(workspaceId);
  const at = session ? await eventAtOf(session).catch(() => null) : null;
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** A turn was sent: a new watch, for the tick to carry on from a restart. */
export function openLinearWatch(agentSessionId: string, sent: { sentAt: number; baselineActivity: number | null }): Promise<void> {
  return openAgentWatch(agentSessionId, sent, sent.sentAt + AWAIT_MS);
}

/** Watch a while; the tick carries on after. */
export async function watchLinearReply(agentSessionId: string): Promise<void> {
  await watchUntil(() => checkTurnRelay(agentSessionId, relayDeps), { forMs: WATCH_MS, everyMs: WATCH_EVERY_MS });
}

/** The tick's part: turns still watched. How many ended. */
export async function relayLinearAwaited(): Promise<number> {
  let done = 0;
  for (const id of await agentRepliesAwaited()) {
    const ended = await checkTurnRelay(id, relayDeps).catch((error: unknown) => {
      console.error(`Linear: couldn't relay to ${id}`, error);
      return false;
    });
    if (ended) done += 1;
  }
  return done;
}
