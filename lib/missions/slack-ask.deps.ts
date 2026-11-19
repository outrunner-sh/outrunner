/** A question card's click, wired (lib/missions/slack-ask.ts). */

import { getInstallation } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { answerAsk, type AskClick, type AskDeps } from "@/lib/missions/slack-ask";
import { linkedAccount, missionLevel } from "@/lib/missions/slack-route.deps";
import { askById, claimAnswer, missionBinding, threadById } from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { recordMissionEvent } from "@/lib/missions/watch.deps";
import { signLinkToken } from "@/lib/slack/slack";
import { postEphemeral, updateMessage, userNames } from "@/lib/slack/web";

export async function handleMissionAsk(click: AskClick): Promise<void> {
  const install = await getInstallation(click.teamId);
  if (!install) return;
  const deps: AskDeps = {
    ask: askById,
    thread: threadById,
    binding: missionBinding,
    mission: sessionById,
    linked: (slackUserId) => linkedAccount(click.teamId, slackUserId),
    level: missionLevel,
    claim: claimAnswer,
    enqueue: recordMissionEvent,
    name: async (slackUserId) => (await userNames(install.botToken, [slackUserId])).get(slackUserId) ?? slackUserId,
    update: (binding, ts, text, blocks) => updateMessage(install.botToken, { channel: binding.channelId, ts, text, blocks }),
    tell: (binding, threadTs, text) => postEphemeral(install.botToken, { channel: binding.channelId, user: click.user, threadTs, text }),
    tellAt: (channel, threadTs, text) => postEphemeral(install.botToken, { channel, user: click.user, threadTs, text }),
    askToConnect: async (binding, threadTs) => {
      const secret = optionalEnv("SLACK_SIGNING_SECRET");
      const base = optionalEnv("RUNTIME_BASE_URL");
      if (!secret || !base) return;
      const token = signLinkToken({ teamId: install.teamId, teamName: install.teamName, userId: click.user, userName: null }, secret);
      const link = new URL(`/slack/link?t=${token}`, base).toString();
      await postEphemeral(install.botToken, {
        channel: binding.channelId,
        user: click.user,
        threadTs,
        text: `Connect Slack to your Outrunner account first: <${link}|Connect Slack to Outrunner> (valid for 10 minutes).`,
      });
    },
  };
  await answerAsk(click, deps).catch((error: unknown) => console.error("Slack: a Mission's question card click failed", error));
}
