/**
 * Mission requests from triggers, wired (lib/missions/requests.ts): the
 * requests and threads in the database, the post queue, and the Mission's
 * outbox.
 */

import {
  type NewRequest,
  announceLate,
  cancelPendingRequests,
  cancelRequest,
  createRequest,
  onRootSettled,
  type RequestDeps,
  updateRequest,
} from "@/lib/missions/requests";
import type { QueuedPost } from "@/lib/missions/slack-outbox";
import { queuePost } from "@/lib/missions/slack-outbox.deps";
import {
  acceptThread,
  cancelRequestRow,
  markAnnounced,
  missionBinding,
  openThreadRequests,
  pendingRequests,
  recordRequest,
  requestByKey,
  rootPostStatus,
  setRequestThread,
  threadById,
  unannouncedRequests,
} from "@/lib/missions/slack-store";
import { recordMissionEvent } from "@/lib/missions/watch.deps";

export function requestDeps(): RequestDeps {
  return {
    binding: missionBinding,
    record: recordRequest,
    request: requestByKey,
    queue: queuePost,
    acceptThread: (input) =>
      acceptThread({
        missionId: input.missionId,
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        requestTs: input.threadTs,
        permalink: null,
        startedBy: input.startedBy,
        startedBySlack: null,
      }),
    setThread: setRequestThread,
    thread: threadById,
    markAnnounced,
    cancel: cancelRequestRow,
    openInThread: openThreadRequests,
    pending: pendingRequests,
    enqueue: recordMissionEvent,
  };
}

export function makeRequest(input: NewRequest) {
  return createRequest(input, requestDeps());
}

export function sendRequestUpdate(missionId: string, key: string, update: { id: string; text: string; from?: string | null }) {
  return updateRequest(missionId, key, update, requestDeps());
}

export function cancelMissionRequest(missionId: string, key: string, reason: string) {
  return cancelRequest(missionId, key, reason, requestDeps());
}

/** A root post settled (lib/missions/slack-outbox.deps.ts). Never throws:
 *  the tick tells the Mission of a request this missed. */
export async function rootSettled(post: QueuedPost, ts: string | null): Promise<void> {
  if (!post.requestKey) return;
  await onRootSettled({ ...post, requestKey: post.requestKey }, ts, requestDeps()).catch((error: unknown) =>
    console.error(`Mission ${post.missionId}: request ${post.requestKey} wasn't told after its root post`, error),
  );
}

/** The tick's part: requests a crash left untold. */
export async function announceUntold(): Promise<number> {
  let told = 0;
  const deps = requestDeps();
  for (const request of await unannouncedRequests(new Date(Date.now() - 60_000))) {
    const root = await rootPostStatus(request.missionId, request.requestKey).catch(() => null);
    if (await announceLate(request, root, deps).catch(() => false)) told++;
  }
  return told;
}

export function cancelPending(missionId: string, bindingRevision: string, reason: string) {
  return cancelPendingRequests(missionId, bindingRevision, reason, requestDeps());
}
