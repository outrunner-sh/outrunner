/**
 * Which Outrunner user a Slack user is (slack_links): service role only — the
 * table has no policy. Made by the user confirming a link Slack handed them
 * (lib/slack/slack.ts), never by typing a member ID.
 */

import type { SlackIdentity } from "@/lib/slack/slack";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type SlackLink = SlackIdentity & { createdAt: string };

/** The owner a Slack user is linked to, or null. */
export async function slackLinkOwner(teamId: string, slackUserId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_links")
    .select("owner_id")
    .eq("team_id", teamId)
    .eq("slack_user_id", slackUserId)
    .maybeSingle();
  if (error) throw error;
  return data?.owner_id ?? null;
}

/** Link a Slack user to the owner; a link they had to someone else moves. */
export async function saveSlackLink(identity: SlackIdentity, ownerId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("slack_links").upsert(
    {
      team_id: identity.teamId,
      slack_user_id: identity.userId,
      owner_id: ownerId,
      team_name: identity.teamName,
      slack_user_name: identity.userName,
    },
    { onConflict: "team_id,slack_user_id" },
  );
  if (error) throw error;
}

export async function listSlackLinks(ownerId: string): Promise<SlackLink[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_links")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map((row) => ({
    teamId: row.team_id,
    teamName: row.team_name,
    userId: row.slack_user_id,
    userName: row.slack_user_name,
    createdAt: row.created_at,
  }));
}

/** Unlink one of the owner's own Slack users. */
export async function deleteSlackLink(ownerId: string, teamId: string, slackUserId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("slack_links")
    .delete()
    .eq("owner_id", ownerId)
    .eq("team_id", teamId)
    .eq("slack_user_id", slackUserId);
  if (error) throw error;
}
