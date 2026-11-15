/**
 * Settings' list of bound channels (lib/missions/mission-channels-list.ts),
 * wired: the bindings and Missions with the service role, each person's level
 * on a Mission's project, and Slack's names through each installation's bot.
 */

import { people } from "@/lib/db/org-members";
import { getInstallation } from "@/lib/db/slack-agent";
import { toWorkspace } from "@/lib/db/mappers";
import { channelKey, type ChannelListDeps, type DisconnectDeps } from "@/lib/missions/mission-channels-list";
import { takeOffCall } from "@/lib/missions/slack-binding";
import { missionLevel, projectNameOf } from "@/lib/missions/slack-route.deps";
import { missionBinding, orgBoundChannels } from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { channelName } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const channelListDeps: ChannelListDeps = {
  bound: orgBoundChannels,
  missions: async (ids) => {
    if (ids.length === 0) return [];
    const { data, error } = await createSupabaseAdminClient().from("workspaces").select("*").in("id", ids).eq("kind", "mission");
    if (error) throw error;
    return (data ?? []).map(toWorkspace);
  },
  level: missionLevel,
  projectName: projectNameOf,
  people: async (ids) => {
    const found = await people(ids);
    return new Map([...found].map(([id, p]) => [id, p.login || p.name || p.email || id]));
  },
  slackNames: async (channels) => {
    const teams = new Map<string, string>();
    const names = new Map<string, string>();
    const installs = new Map(
      await Promise.all([...new Set(channels.map((c) => c.teamId))].map(async (teamId) => [teamId, await getInstallation(teamId).catch(() => null)] as const)),
    );
    for (const [teamId, install] of installs) if (install?.teamName) teams.set(teamId, install.teamName);
    await Promise.all(
      channels.map(async (c) => {
        const install = installs.get(c.teamId);
        const name = install ? await channelName(install.botToken, c.channelId).catch(() => null) : null;
        if (name) names.set(channelKey(c.teamId, c.channelId), name);
      }),
    );
    return { teams, channels: names };
  },
  now: () => Date.now(),
};

export const disconnectDeps: DisconnectDeps = {
  binding: missionBinding,
  mission: sessionById,
  level: missionLevel,
  takeOffCall: (mission, userId) => takeOffCall(mission, userId),
};
