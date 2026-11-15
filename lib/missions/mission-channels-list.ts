/**
 * Settings → Org → Integrations → Slack, "Missions on call" (docs/missions.md,
 * "Bound channels in Settings"): each channel of the org a Mission is on call
 * in, and Disconnect. A member sees the channels of Missions whose project
 * they can read; Disconnect needs write on it, as the header's chip and
 * `@Outrunner stop being on call here` do, and goes the one off-call way
 * (takeOffCall: open cards closed, pending requests cancelled, the Mission
 * told, the org's log).
 *
 * What touches the world comes in as `deps` (mission-channels-list.deps.ts).
 */

import { onCallState, type OnCallFacts, type OnCallState } from "@/lib/missions/on-call-state";
import type { BoundChannelRow, MissionChannel } from "@/lib/missions/slack-store";
import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

export type BoundChannelView = {
  missionId: string;
  missionTitle: string;
  teamId: string;
  teamName: string | null;
  channelId: string;
  channelName: string | null;
  project: string;
  state: OnCallState;
  facts: OnCallFacts;
  boundBy: string | null;
  boundAt: string;
  canDisconnect: boolean;
};

export type ChannelListDeps = {
  bound(orgId: string): Promise<{ row: BoundChannelRow; budget: { until: string | null; period: "day" | "week" | null } | null }[]>;
  missions(ids: string[]): Promise<Workspace[]>;
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
  projectName(mission: Workspace): Promise<string>;
  /** How each person is named: login, name or email. */
  people(ids: string[]): Promise<Map<string, string>>;
  /** Slack's names for the workspaces and channels, best effort. */
  slackNames(channels: { teamId: string; channelId: string }[]): Promise<{ teams: Map<string, string>; channels: Map<string, string> }>;
  now(): number;
};

export const channelKey = (teamId: string, channelId: string) => `${teamId}:${channelId}`;

/** The org's bound channels `viewerId` may see. The route has checked
 *  they're the org's member. */
export async function listBoundChannels(viewerId: string, orgId: string, deps: ChannelListDeps): Promise<BoundChannelView[]> {
  const bound = (await deps.bound(orgId)).filter(({ row }) => row.orgId === orgId);
  if (bound.length === 0) return [];
  const missions = new Map((await deps.missions(bound.map(({ row }) => row.missionId))).map((m) => [m.id, m]));
  const levels = new Map<string, AccessLevel | null>();
  await Promise.all(
    [...missions.values()].map(async (mission) => {
      // A Mission moved to another org isn't this org's to show.
      if (mission.orgId && mission.orgId !== orgId) return;
      levels.set(mission.id, await deps.level(viewerId, mission).catch(() => null));
    }),
  );
  const visible = bound.filter(({ row }) => levels.get(row.missionId));
  if (visible.length === 0) return [];
  const now = deps.now();
  const [projects, people, names] = await Promise.all([
    Promise.all(visible.map(async ({ row }) => [row.missionId, await deps.projectName(missions.get(row.missionId)!).catch(() => "its project")] as const)).then(
      (pairs) => new Map(pairs),
    ),
    deps.people([...new Set(visible.flatMap(({ row }) => (row.boundBy ? [row.boundBy] : [])))]).catch(() => new Map<string, string>()),
    deps.slackNames(visible.map(({ row }) => ({ teamId: row.teamId, channelId: row.channelId }))).catch(() => ({ teams: new Map<string, string>(), channels: new Map<string, string>() })),
  ]);
  return visible.map(({ row, budget }) => {
    const mission = missions.get(row.missionId)!;
    const facts: OnCallFacts = {
      bound: true,
      paused: row.paused,
      idlePaused: row.idlePaused,
      budgetPausedUntil: budget?.until ?? null,
      budgetPausedPeriod: budget?.period ?? null,
    };
    return {
      missionId: row.missionId,
      missionTitle: mission.title ?? mission.branch,
      teamId: row.teamId,
      teamName: names.teams.get(row.teamId) ?? null,
      channelId: row.channelId,
      channelName: names.channels.get(channelKey(row.teamId, row.channelId)) ?? null,
      project: projects.get(row.missionId) ?? "its project",
      state: onCallState(facts, now) ?? "on_call",
      facts,
      boundBy: row.boundBy ? (people.get(row.boundBy) ?? null) : null,
      boundAt: row.boundAt,
      canDisconnect: allows(levels.get(row.missionId), "write"),
    };
  });
}

export type DisconnectDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  mission(id: string): Promise<Workspace | null>;
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
  takeOffCall(mission: Workspace, userId: string): Promise<boolean>;
};

export type DisconnectOutcome = "disconnected" | "not_found" | "forbidden";

/** Take a Mission of the org off call from Settings: `not_found` for one
 *  that isn't on call in the org, or whose project the caller can't read;
 *  `forbidden` without write on it. */
export async function disconnectBoundChannel(viewerId: string, orgId: string, missionId: string, deps: DisconnectDeps): Promise<DisconnectOutcome> {
  const binding = await deps.binding(missionId);
  if (!binding || binding.orgId !== orgId) return "not_found";
  const mission = await deps.mission(missionId);
  if (!mission || mission.kind !== "mission" || (mission.orgId && mission.orgId !== orgId)) return "not_found";
  const level = await deps.level(viewerId, mission);
  if (!level) return "not_found";
  if (!allows(level, "write")) return "forbidden";
  await deps.takeOffCall(mission, viewerId);
  return "disconnected";
}
