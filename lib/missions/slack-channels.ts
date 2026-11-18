/**
 * The Slack channels a person may point a Mission at, by binding it there or
 * by watching it (docs/missions.md): in a Slack workspace they've linked
 * into the Mission's org, with Outrunner installed; a channel Outrunner is
 * in, of that workspace alone (not Slack Connect or shared); and a private
 * one only if they're in it too, as its name and messages are theirs to see.
 */

import { getInstallation, type SlackInstallation } from "@/lib/db/slack-agent";
import { listSlackLinks } from "@/lib/db/slack-links";
import { botChannels, channelIdentity, userPrivateChannels } from "@/lib/slack/web";

export type LinkedTeam = { teamId: string; teamName: string | null; slackUserId: string; install: SlackInstallation };

/** The person's linked Slack workspaces in the org, with the app installed. */
export async function linkedTeams(userId: string, orgId: string): Promise<LinkedTeam[]> {
  const links = (await listSlackLinks(userId)).filter((l) => l.orgId === orgId);
  const teams = [...new Map(links.map((l) => [l.teamId, l])).values()];
  const installed = await Promise.all(teams.map(async (l) => ({ link: l, install: await getInstallation(l.teamId).catch(() => null) })));
  return installed.flatMap(({ link, install }) =>
    install ? [{ teamId: link.teamId, teamName: link.teamName, slackUserId: link.userId, install }] : [],
  );
}

/** The channels the person may pick, for a picker. */
export async function pickableChannels(teams: readonly LinkedTeam[]): Promise<{ teamId: string; teamName: string | null; id: string; name: string }[]> {
  const found: { teamId: string; teamName: string | null; id: string; name: string }[] = [];
  for (const team of teams) {
    const channels = await botChannels(team.install.botToken).catch(() => []);
    const theirs = channels.some((c) => c.private)
      ? await userPrivateChannels(team.install.botToken, team.slackUserId).catch(() => new Set<string>())
      : new Set<string>();
    for (const c of channels) {
      if (c.shared || (c.private && !theirs.has(c.id))) continue;
      found.push({ teamId: team.teamId, teamName: team.teamName, id: c.id, name: c.name });
    }
  }
  return found;
}

export type ChannelCheck = { ok: true; team: LinkedTeam } | { ok: false; status: 400 | 403; error: string };

/** Whether the person may point a Mission of the org at the channel. */
export async function checkChannel(userId: string, orgId: string, teamId: string, channelId: string): Promise<ChannelCheck> {
  const team = (await linkedTeams(userId, orgId)).find((t) => t.teamId === teamId);
  if (!team) return { ok: false, status: 403, error: "Connect your Slack account in that workspace to this org first." };
  const channel = await channelIdentity(team.install.botToken, channelId).catch(() => null);
  if (!channel || channel.id !== channelId || !channel.is_member || channel.is_im || channel.is_mpim || channel.is_ext_shared !== false || channel.is_org_shared !== false || channel.is_shared !== false) {
    return { ok: false, status: 400, error: "Add @Outrunner to that channel first. Slack Connect and shared channels aren't supported." };
  }
  if (channel.is_private !== false) {
    const theirs = await userPrivateChannels(team.install.botToken, team.slackUserId).catch(() => new Set<string>());
    if (!theirs.has(channelId)) return { ok: false, status: 403, error: "That's a private channel you aren't in." };
  }
  return { ok: true, team };
}

/** For checkMissionTarget's deps: why the person can't watch the channel, or null. */
export async function watchableChannel(userId: string, orgId: string, teamId: string, channelId: string): Promise<string | null> {
  const checked = await checkChannel(userId, orgId, teamId, channelId);
  return checked.ok ? null : checked.error;
}
