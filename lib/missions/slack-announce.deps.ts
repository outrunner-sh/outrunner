/**
 * The Slack thread posts' real wiring (lib/missions/slack-announce.ts): the
 * threads and bindings in the database, and the installation's bot. Each
 * never throws: a post that fails is logged, and the news still reaches the
 * Mission through its outbox.
 */

import { getInstallation } from "@/lib/db/slack-agent";
import type { MissionEventKind, MissionEventPayload } from "@/lib/missions/events";
import { announceShipEvent, announceWaiting, type AnnounceDeps } from "@/lib/missions/slack-announce";
import { missionUrl } from "@/lib/missions/slack-binding";
import { latestThread, missionBinding, shipThread } from "@/lib/missions/slack-store";
import { postMessage } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function deps(): AnnounceDeps {
  return {
    shipThread,
    binding: missionBinding,
    latestThread,
    post: async (binding, threadTs, text) => {
      const install = await getInstallation(binding.teamId);
      if (install) await postMessage(install.botToken, { channel: binding.channelId, threadTs, text });
    },
  };
}

export async function tellShipThread(event: { missionId: string; runnerId: string | null; kind: MissionEventKind; payload: MissionEventPayload }): Promise<void> {
  await announceShipEvent(event, deps()).catch((error: unknown) =>
    console.error(`Mission ${event.missionId}: couldn't post its Ship's ${event.kind} in Slack`, error),
  );
}

export async function tellWaiting(missionId: string): Promise<void> {
  await announceWaiting(missionId, missionUrl(missionId), deps()).catch((error: unknown) =>
    console.error(`Mission ${missionId}: couldn't say in Slack that it waits on its owner`, error),
  );
}

/** Of sessions that began waiting on their owner, the Missions: each says
 *  so in its latest thread, if it's on call. */
export async function tellMissionsWaiting(workspaceIds: string[]): Promise<void> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("workspaces")
      .select("id")
      .in("id", [...new Set(workspaceIds)])
      .eq("kind", "mission");
    if (error) throw error;
    for (const row of data ?? []) await tellWaiting(row.id);
  } catch (error) {
    console.error("Missions: couldn't tell Slack threads of a wait", error);
  }
}
