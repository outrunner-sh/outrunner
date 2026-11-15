/** A Ship's question card, wired (lib/missions/ship-ask.ts): the database,
 *  the Ship's box, Slack and the post queue. The watch's parts never throw. */

import { getInstallation } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import {
  answerShipAsk,
  postShipAsk,
  settleShipAsks,
  shipAnswerOperation,
  type ShipAskClick,
  type ShipAskClickDeps,
  type ShipAskPostDeps,
  type ShipAskSettleDeps,
} from "@/lib/missions/ship-ask";
import { queuePost } from "@/lib/missions/slack-outbox.deps";
import { linkedAccount, missionLevel } from "@/lib/missions/slack-route.deps";
import {
  claimShipAnswer,
  closeShipAsk,
  missionBinding,
  openShipAsks,
  postQueued,
  releaseShipAnswer,
  saveShipAskOnce,
  shipAskById,
  shipAskForTool,
  shipLedger,
  threadById,
} from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { AGENT_FEATURE_ASK_CALL_IDENTITY } from "@/lib/runtime/agent-protocol";
import { deliverAnswer, UNREACHABLE_MESSAGE } from "@/lib/runtime/answer-question";
import type { Workspace } from "@/lib/runtime/types";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { signLinkToken } from "@/lib/slack/slack";
import { postEphemeral, updateMessage, userNames } from "@/lib/slack/web";

const NEEDS_COMPUTER = "Answering a Ship's question requires a Runtime Computer provider.";

/** The Ship in the app, for "Other". */
function shipUrl(runnerId: string): string | null {
  const base = optionalEnv("RUNTIME_BASE_URL");
  try {
    return base ? new URL(`/workspaces/${runnerId}`, base).toString() : null;
  } catch {
    return null;
  }
}

/** The Ship's agent, as its owner (Ships run as the Mission's owner). */
async function shipAgent(runner: Workspace) {
  const reach = await reachWorkspaceAgent(runner.id, runner.ownerId, { label: "Slack ship ask", needsComputer: NEEDS_COMPUTER });
  return reach.ok ? reach.reached : null;
}

async function edit(teamId: string, channelId: string, ts: string, text: string, blocks: Record<string, unknown>[]): Promise<void> {
  const install = await getInstallation(teamId);
  if (!install) return;
  await updateMessage(install.botToken, { channel: channelId, ts, text, blocks });
}

function postDeps(): ShipAskPostDeps {
  return {
    ledger: shipLedger,
    binding: missionBinding,
    existing: shipAskForTool,
    queued: postQueued,
    pending: async (runner) => {
      const reached = await shipAgent(runner);
      if (!reached) return null;
      const health = await reached.agent.health(reached.identity).catch(() => null);
      if (!health?.features?.includes(AGENT_FEATURE_ASK_CALL_IDENTITY)) return null;
      return reached.agent.pendingQuestions(reached.identity).catch(() => null);
    },
    save: saveShipAskOnce,
    queue: queuePost,
    shipUrl,
  };
}

function settleDeps(): ShipAskSettleDeps {
  return { open: openShipAsks, close: (id) => closeShipAsk(id), thread: threadById, edit };
}

/** The Ship waits on its ask_user call: its card, once (the Runner watch). */
export async function shipAskWaiting(runner: Workspace, toolUseId: string): Promise<void> {
  await postShipAsk(runner, toolUseId, postDeps()).catch((error: unknown) => console.error(`Ship ${runner.id}: couldn't queue its question for Slack`, error));
}

/** The Ship waits on no call but `keepToolUseId`: its other cards closed
 *  (the Runner watch). */
export async function shipAsksSettled(runner: Workspace, keepToolUseId: string | null): Promise<void> {
  await settleShipAsks(runner.id, keepToolUseId, settleDeps()).catch((error: unknown) => console.error(`Ship ${runner.id}: couldn't close its Slack question cards`, error));
}

/** A click on a Ship's question card. */
export async function handleShipAsk(click: ShipAskClick): Promise<void> {
  const install = await getInstallation(click.teamId);
  if (!install) return;
  const deps: ShipAskClickDeps = {
    ask: shipAskById,
    thread: threadById,
    binding: missionBinding,
    mission: sessionById,
    runner: sessionById,
    linked: (slackUserId) => linkedAccount(click.teamId, slackUserId),
    level: missionLevel,
    claim: claimShipAnswer,
    release: releaseShipAnswer,
    close: closeShipAsk,
    answer: async (runner, ask, label) => {
      const reached = await shipAgent(runner);
      if (!reached) return { ok: false, status: 502, error: UNREACHABLE_MESSAGE };
      const { agent, identity } = reached;
      return deliverAnswer(
        {
          health: () => agent.health(identity),
          pendingQuestions: () => agent.pendingQuestions(identity),
          answer: (req) => agent.answer(identity, req),
        },
        {
          questions: ask.questions,
          answers: [{ selected: [label], other: "" }],
          callId: ask.callId,
          launchEpoch: ask.launchEpoch,
          answerOperationId: shipAnswerOperation(ask.id),
        },
      );
    },
    name: async (slackUserId) => (await userNames(install.botToken, [slackUserId])).get(slackUserId) ?? slackUserId,
    edit,
    tell: (channel, threadTs, text) => postEphemeral(install.botToken, { channel, user: click.user, threadTs, text }),
    askToConnect: async (channel, threadTs) => {
      const secret = optionalEnv("SLACK_SIGNING_SECRET");
      const base = optionalEnv("RUNTIME_BASE_URL");
      if (!secret || !base) return;
      const token = signLinkToken({ teamId: install.teamId, teamName: install.teamName, userId: click.user, userName: null }, secret);
      const link = new URL(`/slack/link?t=${token}`, base).toString();
      await postEphemeral(install.botToken, {
        channel,
        user: click.user,
        threadTs,
        text: `Connect Slack to your Outrunner account first: <${link}|Connect Slack to Outrunner> (valid for 10 minutes).`,
      });
    },
  };
  await answerShipAsk(click, deps).catch((error: unknown) => console.error("Slack: a Ship's question card click failed", error));
}
