/**
 * What the Slack agent does in each channel (slack_channels): watch it for
 * work to file, and post a digest there. Set by talking to the agent; the
 * server's alone (service role).
 */

import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type ChannelSettings = {
  teamId: string;
  channelId: string;
  orgId: string;
  setBy: string | null;
  watch: boolean;
  digest: "daily" | "weekly" | null;
  digestHour: number;
  digestTz: string;
  lastDigestOn: string | null;
};

type Row = {
  team_id: string;
  channel_id: string;
  org_id: string;
  set_by: string | null;
  watch: boolean;
  digest: "daily" | "weekly" | null;
  digest_hour: number;
  digest_tz: string;
  last_digest_on: string | null;
};

function toSettings(row: Row): ChannelSettings {
  return {
    teamId: row.team_id,
    channelId: row.channel_id,
    orgId: row.org_id,
    setBy: row.set_by,
    watch: row.watch,
    digest: row.digest,
    digestHour: row.digest_hour,
    digestTz: row.digest_tz,
    lastDigestOn: row.last_digest_on,
  };
}

export async function channelSettings(teamId: string, channelId: string): Promise<ChannelSettings | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_channels")
    .select("*")
    .eq("team_id", teamId)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (error) throw error;
  return data ? toSettings(data) : null;
}

/** Change what the agent does in a channel; what isn't given stays. */
export async function setChannelSettings(
  /** `setBy` null keeps who set it before (or no one, for a new channel). */
  where: { teamId: string; channelId: string; orgId: string; setBy: string | null },
  patch: Partial<{ watch: boolean; digest: "daily" | "weekly" | null; digestHour: number; digestTz: string }>,
): Promise<ChannelSettings> {
  const current = await channelSettings(where.teamId, where.channelId);
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_channels")
    .upsert(
      {
        team_id: where.teamId,
        channel_id: where.channelId,
        org_id: where.orgId,
        set_by: where.setBy ?? current?.setBy ?? null,
        watch: patch.watch ?? current?.watch ?? false,
        digest: patch.digest !== undefined ? patch.digest : (current?.digest ?? null),
        digest_hour: patch.digestHour ?? current?.digestHour ?? 9,
        digest_tz: patch.digestTz ?? current?.digestTz ?? "UTC",
      },
      { onConflict: "team_id,channel_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return toSettings(data);
}

/** Channels with a digest set. */
export async function digestChannels(): Promise<ChannelSettings[]> {
  const { data, error } = await createSupabaseAdminClient().from("slack_channels").select("*").not("digest", "is", null);
  if (error) throw error;
  return (data ?? []).map(toSettings);
}

/** Give a claimed day back (the digest didn't go out): `previous` is what it
 *  was before the claim. */
export async function releaseDigest(teamId: string, channelId: string, previous: string | null): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("slack_channels")
    .update({ last_digest_on: previous })
    .eq("team_id", teamId)
    .eq("channel_id", channelId);
  if (error) throw error;
}

/** Note a digest went out on a local date; false when another tick already
 *  did (so it goes out once). */
export async function claimDigest(teamId: string, channelId: string, localDate: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_channels")
    .update({ last_digest_on: localDate })
    .eq("team_id", teamId)
    .eq("channel_id", channelId)
    .or(`last_digest_on.is.null,last_digest_on.neq.${localDate}`)
    .select("channel_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}
