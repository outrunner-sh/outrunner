/** Channel delegation is a read principal, never an Outrunner user/session owner. */
import type { User } from "@supabase/supabase-js";
import { isOwner } from "@/lib/auth/allowlist";
import type { ChannelSettings } from "@/lib/db/slack-channels";
import type { TriageActor } from "@/lib/triage/access";
import type { AccessLevel } from "@/lib/orgs/access";

export type ChannelReader = {
  kind: "channel";
  orgId: string;
  levels: ReadonlyMap<string, AccessLevel>;
  teamId: string;
  channelId: string;
  slackUserId: string;
  revision: string;
  authorizedBy: string;
};
export type StatusReader = TriageActor | ChannelReader;

export function canReadItem(reader: StatusReader, item: { projectId: string | null }): boolean {
  return item.projectId === null ? !("kind" in reader) : reader.levels.has(item.projectId);
}

export type ChannelIdentity = {
  id: string; is_im?: boolean; is_mpim?: boolean; is_member?: boolean;
  is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean; shared_team_ids?: string[];
};
export type SenderIdentity = { id: string; team_id?: string; deleted?: boolean; is_bot?: boolean; is_stranger?: boolean };
export type ChannelAccessDeps = {
  settings(team: string, channel: string): Promise<ChannelSettings | null>;
  adminActive(user: string, org: string): Promise<boolean>;
  projects(org: string): Promise<{ id: string; fullName: string }[]>;
  channel(): Promise<ChannelIdentity>;
  sender(): Promise<SenderIdentity>;
};
export type ChannelLocation = { teamId: string; channel: string; user: string; channelType?: string | null };

/** Fail closed on missing metadata/scopes; a channel becoming shared invalidates access. */
export async function localChannel(where: ChannelLocation, deps: ChannelAccessDeps): Promise<boolean> {
  if (where.channelType === "im" || !/^[CG]/.test(where.channel)) return false;
  const [channel, sender] = await Promise.all([deps.channel(), deps.sender()]);
  return channel.id === where.channel && channel.is_member === true && !channel.is_im && !channel.is_mpim &&
    channel.is_ext_shared === false && channel.is_org_shared === false && channel.is_shared === false &&
    (!channel.shared_team_ids?.length || channel.shared_team_ids.every((id) => id === where.teamId)) &&
    sender.id === where.user && sender.team_id === where.teamId && !sender.deleted && !sender.is_bot && !sender.is_stranger;
}

/** No cached owner account or inferred authority from installation/digest/watch. */
export async function channelReader(where: ChannelLocation, deps: ChannelAccessDeps): Promise<ChannelReader | null> {
  if (where.channelType === "im" || !/^[CG]/.test(where.channel)) return null;
  const settings = await deps.settings(where.teamId, where.channel);
  if (!settings || settings.teamId !== where.teamId || settings.channelId !== where.channel ||
      !settings.sharedBy || !settings.sharedRevision || !settings.sharedProjects.length) return null;
  if (!(await deps.adminActive(settings.sharedBy, settings.orgId)) || !(await localChannel(where, deps))) return null;
  const allowed = new Set(settings.sharedProjects);
  const levels = new Map<string, AccessLevel>((await deps.projects(settings.orgId)).filter((p) => allowed.has(p.id)).map((p) => [p.id, "read"]));
  if (!levels.size) return null;
  return {
    kind: "channel", orgId: settings.orgId, levels, teamId: where.teamId, channelId: where.channel,
    slackUserId: where.user, revision: settings.sharedRevision, authorizedBy: settings.sharedBy,
  };
}

export type AccessCommand = { action: "share"; repos: string[] } | { action: "revoke" } | { action: "help" };
/** Exact commands, parsed before the model. A model/tool call can never delegate. */
export function accessCommand(text: string, botUserId: string): AccessCommand | null {
  const clean = text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), "").trim();
  if (/^revoke channel access[.!]?$/i.test(clean)) return { action: "revoke" };
  const match = /^share channel access for\s+(.+)$/i.exec(clean);
  if (match) {
    const repos = [...new Set(match[1].split(/[,\s]+/).filter(Boolean).map((r) => r.toLowerCase()))];
    if (repos.length && repos.length <= 50 && repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r))) return { action: "share", repos };
    return { action: "help" };
  }
  return /^share channel access\b/i.test(clean) ? { action: "help" } : null;
}

/** Ban/deletion is enforced even when the admin API can still return the user. */
export function slackAccountActive(user: User, now = Date.now()): boolean {
  return !user.deleted_at && !(user.banned_until && Date.parse(user.banned_until) > now) && isOwner(user);
}

/** Linked members retain their own limits; a channel grant can only narrow them. */
export function restrictToChannel(actor: TriageActor, grant: ChannelReader | null): StatusReader {
  if (!grant) return actor;
  return { ...grant, levels: new Map([...grant.levels].filter(([id]) => actor.orgId === grant.orgId && actor.levels.has(id))) };
}
