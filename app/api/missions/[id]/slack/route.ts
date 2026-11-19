import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getInstallation } from "@/lib/db/slack-agent";
import { isSameOriginRequest } from "@/lib/http/guards";
import { announceBinding, takeOffCall } from "@/lib/missions/slack-binding";
import { checkChannel, linkedTeams, pickableChannels } from "@/lib/missions/slack-channels";
import { missionLevel, projectNameOf } from "@/lib/missions/slack-route.deps";
import { bindChannel, missionBinding, setChannelPaused } from "@/lib/missions/slack-store";
import type { MissionSlackView } from "@/lib/missions/slack-text";
import { ownsMission } from "@/lib/missions/view.deps";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";
import { channelName } from "@/lib/slack/web";

/**
 * A Mission's Slack channel (docs/missions.md, "On call in Slack"), for its
 * header: which it's on call in, and putting it on or off call, or pausing
 * it. Its owner's alone, as the Mission is; changing it needs write on its
 * project, as `be on call here` in Slack does.
 */

type RouteContext = { params: Promise<{ id: string }> };


async function load(context: RouteContext): Promise<{ ownerId: string; mission: Workspace } | NextResponse> {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const mission = await ownsMission(owner.id, id);
  if (!mission) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  return { ownerId: owner.id, mission };
}

async function canManage(ownerId: string, mission: Workspace): Promise<boolean> {
  return allows(await missionLevel(ownerId, mission), "write");
}

/** Where it's on call; with `?channels=1` (the picker opening), the channels
 *  it could go on call in, which asks Slack. */
export async function GET(request: Request, context: RouteContext) {
  const loaded = await load(context);
  if (loaded instanceof NextResponse) return loaded;
  const { ownerId, mission } = loaded;
  const [binding, manage] = await Promise.all([missionBinding(mission.id).catch(() => null), canManage(ownerId, mission)]);
  const view: MissionSlackView = { binding: null, channels: [], canManage: manage, hint: null };
  if (binding) {
    const install = await getInstallation(binding.teamId).catch(() => null);
    view.binding = {
      teamId: binding.teamId,
      channelId: binding.channelId,
      channelName: install ? await channelName(install.botToken, binding.channelId) : null,
      paused: binding.paused,
      listen: binding.listen,
    };
  } else if (manage && mission.orgId && new URL(request.url).searchParams.get("channels") === "1") {
    // Private channels only the owner is in (slack-channels.ts).
    const teams = await linkedTeams(ownerId, mission.orgId);
    view.channels.push(...(await pickableChannels(teams)));
    if (teams.length === 0) view.hint = "Connect your Slack account to this org first (Settings → Integrations), with the Outrunner Slack app installed.";
    else if (view.channels.length === 0) view.hint = "Add @Outrunner to a channel in Slack first.";
  }
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
}

/** Put the Mission on call in a channel: `{ teamId, channelId }`. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const loaded = await load(context);
  if (loaded instanceof NextResponse) return loaded;
  const { ownerId, mission } = loaded;
  if (!(await canManage(ownerId, mission))) return NextResponse.json({ error: "That needs write on the Mission's project." }, { status: 403 });
  if (!mission.orgId) return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  // As in Slack's `be on call here`: a Mission that's ending or gone can't take a channel.
  if (["archiving", "archived", "destroying", "destroyed", "failed"].includes(mission.status)) {
    return NextResponse.json({ error: "This Mission is archived or has stopped: it can't go on call." }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as { teamId?: unknown; channelId?: unknown } | null;
  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  const channelId = typeof body?.channelId === "string" ? body.channelId : "";
  if (!/^[A-Z0-9]{2,32}$/.test(teamId) || !/^[CG][A-Z0-9]{2,32}$/.test(channelId)) {
    return NextResponse.json({ error: "Choose a channel." }, { status: 400 });
  }
  // Outrunner in it, the workspace's own (not Slack Connect or shared), and
  // a private one only if the owner is in it.
  const checked = await checkChannel(ownerId, mission.orgId, teamId, channelId);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
  const outcome = await bindChannel({ missionId: mission.id, orgId: mission.orgId, teamId, channelId, boundBy: ownerId });
  if (outcome === "channel_taken") return NextResponse.json({ error: "Another Mission is on call in that channel." }, { status: 409 });
  if (outcome === "mission_bound") return NextResponse.json({ error: "This Mission is on call in another channel already." }, { status: 409 });
  const binding = await missionBinding(mission.id);
  if (binding) await announceBinding(binding, mission, await projectNameOf(mission), ownerId);
  return NextResponse.json({ ok: true });
}

/** Pause or resume it there: `{ paused }`. */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const loaded = await load(context);
  if (loaded instanceof NextResponse) return loaded;
  const { ownerId, mission } = loaded;
  if (!(await canManage(ownerId, mission))) return NextResponse.json({ error: "That needs write on the Mission's project." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") return NextResponse.json({ error: "Say whether it's paused." }, { status: 400 });
  if (!(await setChannelPaused(mission.id, body.paused))) return NextResponse.json({ error: "The Mission isn't on call in Slack." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Take it off call. */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const loaded = await load(context);
  if (loaded instanceof NextResponse) return loaded;
  const { ownerId, mission } = loaded;
  if (!(await canManage(ownerId, mission))) return NextResponse.json({ error: "That needs write on the Mission's project." }, { status: 403 });
  await takeOffCall(mission, ownerId);
  return NextResponse.json({ ok: true });
}
