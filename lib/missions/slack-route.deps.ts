/**
 * The Slack → Mission router's real wiring (lib/missions/slack-route.ts):
 * the bindings and threads in the database, the sender's linked account and
 * access, the Mission's outbox, and Slack through the installation's bot.
 */

import { after } from "@/lib/observability/after";

import { POST as interruptPOST } from "@/app/api/workspaces/[id]/interrupt/route";
import { getOwner } from "@/lib/auth/owner";
import { getEnvironment } from "@/lib/db/environments";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { memberRole } from "@/lib/db/orgs";
import type { SlackInstallation } from "@/lib/db/slack-agent";
import { slackLinkTarget } from "@/lib/db/slack-links";
import { toWorkspace } from "@/lib/db/mappers";
import { sessionById } from "@/lib/missions/store";
import { announceBinding, takeOffCall } from "@/lib/missions/slack-binding";
import {
  acceptThread,
  bindChannel,
  channelBinding,
  channelThread,
  recordRequest,
  setChannelPaused,
  setThreadMuted,
} from "@/lib/missions/slack-store";
import type { FoundProject, Requester, SlackRouteDeps, SlackRouteMessage } from "@/lib/missions/slack-route";
import { recordMissionEvent } from "@/lib/missions/watch.deps";
import type { Workspace } from "@/lib/runtime/types";
import { createCloudSession } from "@/lib/session/create-cloud-session";
import { slackAccountActive } from "@/lib/slack/channel-access";
import { asBrowser } from "@/lib/slack/research";
import { channelIdentity, messagePermalink, postEphemeral, postMessage, senderIdentity, userNames } from "@/lib/slack/web";
import { ActAsUserError, actAsUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { localChannel } from "@/lib/slack/channel-access";

function db() {
  return createSupabaseAdminClient();
}

/** The Slack user's linked account, while it may still sign in and is still
 *  a member of the org it's linked into. */
export async function linkedAccount(teamId: string, slackUserId: string): Promise<Requester | null> {
  const target = await slackLinkTarget(teamId, slackUserId);
  if (!target) return null;
  const { data, error } = await db().auth.admin.getUserById(target.ownerId);
  if (error || !data.user || !slackAccountActive(data.user)) return null;
  if (!(await memberRole(target.orgId, target.ownerId))) return null;
  return { userId: target.ownerId, orgId: target.orgId };
}

/** Someone's level on a Mission's project (its `environments` row), or its
 *  repository's for one from before projects. */
export async function missionLevel(userId: string, mission: Workspace) {
  return mission.environmentId ? environmentLevel(userId, mission.environmentId) : projectLevel(userId, mission.projectId);
}

export async function projectNameOf(mission: Workspace): Promise<string> {
  if (mission.environmentId) {
    const { data } = await db().from("environments").select("name").eq("id", mission.environmentId).maybeSingle();
    if (data?.name) return data.name;
  }
  const { data } = await db().from("projects").select("full_name").eq("id", mission.projectId).maybeSingle();
  return data?.full_name ?? "its project";
}

/** A project the requester can see in their org, by its name or one of its
 *  repositories' (owner/name). */
async function findProject(requester: Requester, name: string): Promise<FoundProject | { ambiguous: string[] } | null> {
  const want = name.trim().toLowerCase();
  const { data: environments, error } = await db()
    .from("environments")
    .select("id, name")
    .eq("org_id", requester.orgId)
    .is("archived_at", null);
  if (error) throw error;
  let matches = (environments ?? []).filter((e) => e.name.trim().toLowerCase() === want);
  if (matches.length === 0 && /^[\w.-]+\/[\w.-]+$/.test(want)) {
    const { data: projects } = await db().from("projects").select("id, full_name").eq("org_id", requester.orgId);
    const repo = (projects ?? []).find((p) => p.full_name.toLowerCase() === want);
    if (repo) {
      const { data: links } = await db().from("environment_repos").select("environment_id").eq("org_id", requester.orgId).eq("project_id", repo.id);
      const ids = new Set((links ?? []).map((l) => l.environment_id));
      matches = (environments ?? []).filter((e) => ids.has(e.id));
    }
  }
  const visible: FoundProject[] = [];
  for (const environment of matches) {
    if (await environmentLevel(requester.userId, environment.id)) visible.push({ id: environment.id, name: environment.name });
  }
  if (visible.length === 0) return null;
  if (visible.length > 1) return { ambiguous: visible.map((p) => p.name) };
  return visible[0];
}

/** Their own Missions on the project that aren't archived or on call
 *  anywhere, newest first. */
async function freeMissions(userId: string, projectId: string): Promise<Workspace[]> {
  const { data, error } = await db()
    .from("workspaces")
    .select("*")
    .eq("owner_id", userId)
    .eq("kind", "mission")
    .eq("environment_id", projectId)
    .not("status", "in", "(archiving,archived,destroying,destroyed,failed)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const missions = (data ?? []).map(toWorkspace);
  if (missions.length === 0) return [];
  const { data: bound } = await db().from("mission_channels").select("mission_id").in("mission_id", missions.map((m) => m.id));
  const taken = new Set((bound ?? []).map((b) => b.mission_id));
  return missions.filter((m) => !taken.has(m.id));
}

/** Start a Mission on the project as the requester, as the app's new-Mission
 *  dialog does (app/api/missions), with a first message saying what it's
 *  for; answered as soon as its row is made, its box set up after. */
async function createMission(requester: Requester, project: FoundProject, channel: string): Promise<{ missionId: string } | { error: string }> {
  let made: (id: string) => void = () => undefined;
  const created = new Promise<{ missionId: string }>((resolve) => {
    made = (missionId) => resolve({ missionId });
  });
  const prompt = `You are on call in the Slack channel ${channel} for ${project.name}. People there will mention Outrunner with tasks, which reach you as <slack_request> blocks. Wait for them: there's nothing to do until one arrives.`;
  const run = (async (): Promise<{ missionId: string } | { error: string }> => {
    try {
      return await actAsUser(requester.userId, async () => {
        const owner = await getOwner();
        if (!owner) return { error: "your Outrunner account can't start one now." };
        const environment = await getEnvironment(owner.id, project.id);
        const projectId = environment?.defaultForProjectId ?? environment?.repos[0]?.projectId;
        if (!environment || !projectId) return { error: `${project.name} has no repositories.` };
        let missionId: string | null = null;
        const response = await createCloudSession(owner, projectId, { agent: "claude", prompt }, {
          kind: "mission",
          environmentId: environment.id,
          title: `On call: ${project.name}`,
          firstMessage: prompt,
          source: "slack",
          inline: true,
          onCreated: async (id) => {
            missionId = id;
            made(id);
          },
        });
        if (response.status === 202 && missionId) return { missionId };
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return { error: typeof body?.error === "string" ? body.error : `it was refused (${response.status}).` };
      });
    } catch (error) {
      if (error instanceof ActAsUserError) return { error: error.message };
      console.error("Slack: a Mission didn't start", error);
      return { error: "Outrunner couldn't start it, and logged why." };
    }
  })();
  try {
    after(() => run.then(() => undefined));
  } catch {
    // Outside a request: the promise runs on its own.
  }
  return Promise.race([created, run]);
}

async function interrupt(mission: Workspace): Promise<boolean> {
  return actAsUser(mission.ownerId, async () => {
    const response = await interruptPOST(asBrowser(`/api/workspaces/${mission.id}/interrupt`, {}), {
      params: Promise.resolve({ id: mission.id }),
    });
    return response.ok;
  }).catch(() => false);
}

export function slackRouteDeps(
  install: SlackInstallation,
  message: SlackRouteMessage,
  askToConnect: (threadTs: string) => Promise<void>,
): SlackRouteDeps {
  const { teamId, channel } = message;
  return {
    botUserId: install.botUserId,
    // Can't tell (a database hiccup, or the migration not applied yet): the
    // Slack agent goes on as in a channel with no Mission.
    binding: (team, id) =>
      channelBinding(team, id).catch((error: unknown) => {
        console.error("Slack: couldn't tell whether a Mission is on call here", error);
        return null;
      }),
    thread: channelThread,
    mission: sessionById,
    linked: (slackUserId) => linkedAccount(teamId, slackUserId),
    level: missionLevel,
    projectName: projectNameOf,
    acceptThread: (input) => acceptThread({ ...input, teamId, channelId: channel }),
    recordRequest,
    setMuted: setThreadMuted,
    setPaused: async (missionId, paused) => {
      await setChannelPaused(missionId, paused);
    },
    unbind: async (binding, by) => {
      const mission = await sessionById(binding.missionId);
      if (mission) await takeOffCall(mission, by.userId);
    },
    enqueue: recordMissionEvent,
    interrupt,
    name: async (slackUserId) => (await userNames(install.botToken, [slackUserId])).get(slackUserId) ?? slackUserId,
    permalink: (ts) => messagePermalink(install.botToken, channel, ts),
    reply: async (threadTs, text) => {
      await postMessage(install.botToken, { channel, threadTs, text });
    },
    tell: (threadTs, text) => postEphemeral(install.botToken, { channel, user: message.user, threadTs, text }),
    askToConnect,
    findProject,
    projectLevel: environmentLevel,
    localChannel: () =>
      localChannel(
        { teamId, channel, user: message.user, channelType: message.channelType },
        {
          channel: () => channelIdentity(install.botToken, channel),
          sender: () => senderIdentity(install.botToken, message.user),
          // Unused by localChannel.
          settings: async () => null,
          adminActive: async () => false,
          projects: async () => [],
        },
      ),
    freeMissions,
    createMission: (requester, project) => createMission(requester, project, `<#${channel}>`),
    bind: (input) => bindChannel({ ...input, teamId, channelId: channel }),
    announce: (binding, mission, project, by) => announceBinding(binding, mission, project, by.userId),
  };
}
