/**
 * Which Outrunner user a Slack user is, and the org their captures go to
 * (slack_links): service role only, as the table has no policy. Made by the
 * user signing in with Slack as that Slack user (app/api/integrations/slack/
 * oauth), never by typing a member ID. Leaving the org takes the link away.
 */

import type { SlackIdentity } from "@/lib/slack/slack";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type SlackLink = SlackIdentity & { orgId: string; orgName: string | null; createdAt: string };

/** The owner and org a Slack user is linked to, or null. */
export async function slackLinkTarget(
  teamId: string,
  slackUserId: string,
): Promise<{ ownerId: string; orgId: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("slack_links")
    .select("owner_id, org_id")
    .eq("team_id", teamId)
    .eq("slack_user_id", slackUserId)
    .maybeSingle();
  if (error) throw error;
  return data ? { ownerId: data.owner_id, orgId: data.org_id } : null;
}

/** Link a Slack user to the owner, for the org; a link they had moves. */
export async function saveSlackLink(identity: SlackIdentity, ownerId: string, orgId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("slack_links").upsert(
    {
      team_id: identity.teamId,
      slack_user_id: identity.userId,
      owner_id: ownerId,
      org_id: orgId,
      team_name: identity.teamName,
      slack_user_name: identity.userName,
    },
    { onConflict: "team_id,slack_user_id" },
  );
  if (error) throw error;
}

export async function listSlackLinks(ownerId: string): Promise<SlackLink[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("slack_links")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const orgIds = [...new Set(data.map((row) => row.org_id))];
  const { data: orgs, error: orgsError } = orgIds.length
    ? await client.from("organizations").select("id, name").in("id", orgIds)
    : { data: [], error: null };
  if (orgsError) throw orgsError;
  const names = new Map((orgs ?? []).map((o) => [o.id, o.name]));
  return data.map((row) => ({
    teamId: row.team_id,
    teamName: row.team_name,
    userId: row.slack_user_id,
    userName: row.slack_user_name,
    orgId: row.org_id,
    orgName: names.get(row.org_id) ?? null,
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
