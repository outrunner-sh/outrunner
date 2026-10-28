/**
 * An org's Slack, as Settings shows it: the Slack workspaces its members have
 * connected from (and whether the app's bot is installed there), who is
 * connected, and what the agent does in each channel. Read as the server; the
 * pages calling it have checked the viewer is the org's member.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgSlack = {
  workspaces: { teamId: string; teamName: string | null; installed: boolean }[];
  members: { teamId: string; slackUser: string; ownerId: string; outrunnerName: string | null }[];
  channels: { teamId: string; channelId: string; watch: boolean; digest: "daily" | "weekly" | null; hour: number; tz: string }[];
};

export async function orgSlack(orgId: string): Promise<OrgSlack> {
  const db = createSupabaseAdminClient();
  const [{ data: links, error: linksError }, { data: channels, error: channelsError }] = await Promise.all([
    db.from("slack_links").select("team_id, team_name, slack_user_id, slack_user_name, owner_id").eq("org_id", orgId),
    db.from("slack_channels").select("team_id, channel_id, watch, digest, digest_hour, digest_tz").eq("org_id", orgId),
  ]);
  if (linksError) throw linksError;
  if (channelsError) throw channelsError;
  const teamIds = [...new Set([...(links ?? []).map((l) => l.team_id), ...(channels ?? []).map((c) => c.team_id)])];
  const { data: installs, error: installsError } = teamIds.length
    ? await db.from("slack_installations").select("team_id, team_name").in("team_id", teamIds)
    : { data: [], error: null };
  if (installsError) throw installsError;
  const installed = new Map((installs ?? []).map((i) => [i.team_id, i.team_name]));
  const names = new Map((links ?? []).map((l) => [l.team_id, l.team_name]));

  // Outrunner's name for each connected member: their GitHub login.
  const owners = [...new Set((links ?? []).map((l) => l.owner_id))];
  const logins = new Map<string, string | null>();
  await Promise.all(
    owners.map(async (id) => {
      const { data } = await db.auth.admin.getUserById(id);
      const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
      logins.set(id, typeof meta.user_name === "string" ? meta.user_name : (data.user?.email ?? null));
    }),
  );

  return {
    workspaces: teamIds.map((teamId) => ({
      teamId,
      teamName: installed.get(teamId) ?? names.get(teamId) ?? null,
      installed: installed.has(teamId),
    })),
    members: (links ?? []).map((l) => ({
      teamId: l.team_id,
      slackUser: l.slack_user_name ? `@${l.slack_user_name}` : l.slack_user_id,
      ownerId: l.owner_id,
      outrunnerName: logins.get(l.owner_id) ?? null,
    })),
    channels: (channels ?? []).map((c) => ({
      teamId: c.team_id,
      channelId: c.channel_id,
      watch: c.watch,
      digest: c.digest,
      hour: c.digest_hour,
      tz: c.digest_tz,
    })),
  };
}
