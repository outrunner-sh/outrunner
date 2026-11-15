import { NextResponse } from "next/server";

import { listBoundChannels } from "@/lib/missions/mission-channels-list";
import { channelListDeps } from "@/lib/missions/mission-channels-list.deps";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The org's Slack channels a Mission is on call in (Settings → Org →
 * Integrations → Slack; lib/missions/mission-channels-list.ts), for any
 * member: those of Missions whose project they can read, each saying
 * whether they may Disconnect it (write on the project).
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  try {
    const channels = await listBoundChannels(caller.owner.id, id, channelListDeps);
    return NextResponse.json({ channels }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`Org ${id}: couldn't list Missions' channels`, error);
    return NextResponse.json({ error: "Couldn't load the channels. Try again." }, { status: 500 });
  }
}
