import { slackAccountActive } from "@/lib/slack/channel-access";
import { memberRole } from "@/lib/db/orgs";
import { listOrgProjects } from "@/lib/db/org-access";
import { channelSettings } from "@/lib/db/slack-channels";
import { orgModelKey, type SlackInstallation } from "@/lib/db/slack-agent";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { agentTurn } from "@/lib/slack/agent-model";
import { findItems, itemStatus, recentWork } from "@/lib/slack/lookups";
import { channelIdentity, senderIdentity } from "@/lib/slack/web";
import type { ChannelLocation, ChannelReader } from "@/lib/slack/channel-access";
import type { SharedChannelDeps } from "@/lib/slack/shared-channel";

export async function activeChannelAdmin(userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
  return !error && !!data.user && slackAccountActive(data.user) && (await memberRole(orgId, userId)) === "admin";
}

export function sharedChannelDeps(install: SlackInstallation, where: ChannelLocation): SharedChannelDeps {
  return {
    settings: channelSettings,
    adminActive: activeChannelAdmin,
    projects: listOrgProjects,
    channel: () => channelIdentity(install.botToken, where.channel),
    sender: () => senderIdentity(install.botToken, where.user),
    save: async (actor, projectIds) => {
      const { error } = await createSupabaseAdminClient().rpc("set_slack_channel_access", {
        target_team: where.teamId, target_channel: where.channel, target_org: actor.orgId, admin_id: actor.userId, project_ids: projectIds, slack_user_id: where.user,
      });
      if (error) throw error;
    },
    audit: recordChannelAudit,
    lookup: (tool, reader, args) => {
      if (tool === "recent_work") return recentWork(reader, args);
      if (tool === "find_items") return findItems(reader, args);
      if (tool === "item_status") return itemStatus(reader, args);
      throw new Error("Unsupported shared lookup");
    },
    model: async (orgId, messages, lookups) => agentTurn(await orgModelKey(orgId), messages, lookups),
  };
}

/** Attribution is the actual Slack sender, never the delegating admin's account.
 * Audit failure prevents delegated reads. No prompt/tool arguments are logged. */
async function recordChannelAudit(reader: ChannelReader, action: "asked" | "lookup", tool?: string) {
  const { error } = await createSupabaseAdminClient().from("audit_events").insert({
    org_id: reader.orgId, actor_type: "system", actor_id: null,
    actor_label: `Slack ${reader.teamId}/${reader.slackUserId}`,
    action: `slack_channel.${action}`, resource_type: "slack_channel", resource_id: `${reader.teamId}/${reader.channelId}`,
    resource_label: reader.channelId,
    details: { slack_team_id: reader.teamId, slack_channel_id: reader.channelId, slack_user_id: reader.slackUserId,
      authorized_by: reader.authorizedBy, revision: reader.revision, project_ids: [...reader.levels.keys()], ...(tool && { tool }) },
  });
  if (error) throw error;
}
