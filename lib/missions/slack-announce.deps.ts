/**
 * The Slack thread cards' real wiring (lib/missions/slack-announce.ts): the
 * Ship ledger and bindings in the database, and the post queue. Each never
 * throws: a card that can't be queued is logged, and the news still reaches
 * the Mission through its outbox.
 */

import type { MissionEventKind, MissionEventPayload, PullRequestRef } from "@/lib/missions/events";
import { announcePullRequest, announceShipEvent, announceWaiting, type AnnounceDeps } from "@/lib/missions/slack-announce";
import { missionUrl } from "@/lib/missions/slack-binding";
import { queuePost } from "@/lib/missions/slack-outbox.deps";
import { latestRequest, latestThread, missionBinding, shipLedger } from "@/lib/missions/slack-store";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function deps(): AnnounceDeps {
  return { ledger: shipLedger, binding: missionBinding, latestThread, latestRequest, queue: queuePost };
}

export async function tellShipThread(event: {
  missionId: string;
  runnerId: string | null;
  kind: MissionEventKind;
  payload: MissionEventPayload;
  key: string;
}): Promise<void> {
  await announceShipEvent(event, deps()).catch((error: unknown) =>
    console.error(`Mission ${event.missionId}: couldn't queue its Ship's ${event.kind} for Slack`, error),
  );
}

/** A Ship's pull request seen open: its thread hears so, once a pull request. */
export async function tellPullRequestOpened(runner: { id: string; parentMissionId?: string | null; title: string | null; branch: string }, pr: PullRequestRef): Promise<void> {
  if (!runner.parentMissionId) return;
  await announcePullRequest(
    { missionId: runner.parentMissionId, runnerId: runner.id, kind: "opened", pr, ship: runner.title ?? runner.branch },
    deps(),
  ).catch((error: unknown) => console.error(`Ship ${runner.id}: couldn't queue its pull request's card for Slack`, error));
}

/** Of notifications that a session began waiting on its owner, the
 *  Missions': each says so in its latest thread, if it's on call. */
export async function tellMissionsWaiting(waits: { notificationId: string; workspaceId: string }[]): Promise<void> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("workspaces")
      .select("id")
      .in("id", [...new Set(waits.map((w) => w.workspaceId))])
      .eq("kind", "mission");
    if (error) throw error;
    const missions = new Set((data ?? []).map((row) => row.id));
    for (const wait of waits.filter((w) => missions.has(w.workspaceId))) {
      await announceWaiting(wait.workspaceId, wait.notificationId, missionUrl(wait.workspaceId), deps());
    }
  } catch (error) {
    console.error("Missions: couldn't tell Slack threads of a wait", error);
  }
}
