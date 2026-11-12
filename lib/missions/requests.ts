/**
 * A Mission's requests from its triggers (docs/missions.md, "Triggers"): a
 * watched Slack channel's message, a webhook, a schedule, a Linear issue.
 * Each is one request, under a stable key (its automation run's, or its
 * Linear issue's), recorded before anything else, so a retry is the same
 * request:
 *
 *   1. recorded (mission_slack_requests), with who it's for;
 *   2. on call, a root post in the Mission's bound channel, through the post
 *      queue: a new message per request, which is its thread for the
 *      Mission's replies and its Ships' cards;
 *   3. the Mission told, once (a `request` event in its outbox), with that
 *      thread once the root post went, or without one when there's no
 *      channel, or the post failed. The tick tells it of any request a crash
 *      left untold.
 *
 * Its updates (a Linear prompt) and its cancellation (a Linear issue closed
 * or taken back) reach the Mission as their own events; a cancelled request's
 * Ships take no more work for it (lib/missions/slack-tools.ts).
 *
 * What touches the world comes in as `deps` (requests.deps.ts).
 */

import { eventKey, type RequestEventPayload } from "@/lib/missions/events";
import type { QueueOutcome, QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionRequest, MissionThread } from "@/lib/missions/slack-store";
import type { RecordedEvent } from "@/lib/missions/watch";

export type RequestSource = RequestEventPayload["source"];

/** A request as a trigger makes it. */
export type NewRequest = {
  missionId: string;
  source: RequestSource;
  key: string;
  title: string;
  text: string;
  /** Whose authority it runs under: the person who asked (Linear), else the
   *  Mission owner who approved the trigger. Rechecked before acting. */
  requestedBy: string | null;
  from?: string | null;
  link?: string | null;
  automationId?: string | null;
  automationName?: string | null;
  externalRef?: string | null;
  externalSession?: string | null;
  installationId?: string | null;
};

export type RequestDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  /** Record it; true when it's new. */
  record(request: MissionRequest): Promise<boolean>;
  request(missionId: string, key: string): Promise<MissionRequest | null>;
  queue(post: QueuedPost): Promise<QueueOutcome>;
  /** Make the root post's thread the Mission's, for this request. */
  acceptThread(input: { missionId: string; teamId: string; channelId: string; threadTs: string; startedBy: string | null }): Promise<MissionThread>;
  setThread(missionId: string, key: string, threadId: string): Promise<void>;
  thread(id: string): Promise<MissionThread | null>;
  /** Mark it told; true for the first only. */
  markAnnounced(missionId: string, key: string): Promise<boolean>;
  cancel(missionId: string, key: string): Promise<boolean>;
  enqueue(event: RecordedEvent): Promise<boolean>;
};

/** The most of a request's text kept and told. */
export const REQUEST_TEXT_MAX = 8000;
/** The most of it its root post shows. */
const ROOT_TEXT_MAX = 600;

const SOURCE_LABEL: Record<RequestSource, string> = {
  slack_watch: "a watched channel",
  webhook: "a webhook",
  schedule: "a schedule",
  linear: "Linear",
};

/** Text from outside, safe in Slack's mrkdwn: no mentions, links or
 *  channel-wide pings it didn't mean to make. */
export function slackSafe(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A request's root post: where it came from, and what it is, in short. */
export function rootText(request: Pick<NewRequest, "source" | "title" | "text" | "automationName" | "link">): string {
  const via = request.automationName ? ` (${slackSafe(request.automationName)})` : "";
  const body = request.text.trim().slice(0, ROOT_TEXT_MAX);
  const cut = request.text.trim().length > ROOT_TEXT_MAX ? "…" : "";
  const link = request.link && /^https:\/\//.test(request.link) ? `\n<${request.link.replace(/[<>|]/g, "")}|Open>` : "";
  return `:inbox_tray: *New request from ${SOURCE_LABEL[request.source]}${via}:* ${slackSafe(request.title)}${body ? `\n>${slackSafe(body).replace(/\n/g, "\n>")}${cut}` : ""}${link}`;
}

/** Make a request (or find it made): recorded, root-posted when on call, and
 *  the Mission told. What came of it. */
export async function createRequest(input: NewRequest, deps: RequestDeps): Promise<"created" | "exists"> {
  const binding = await deps.binding(input.missionId);
  const fresh = await deps.record({
    missionId: input.missionId,
    requestKey: input.key,
    threadId: null,
    bindingRevision: binding?.revision ?? null,
    messageTs: null,
    requestedBy: input.requestedBy,
    requestedBySlack: null,
    source: input.source,
    title: input.title.slice(0, 300),
    externalRef: input.externalRef ?? null,
    externalSession: input.externalSession ?? null,
    installationId: input.installationId ?? null,
    automationId: input.automationId ?? null,
    details: { text: input.text.slice(0, REQUEST_TEXT_MAX), from: input.from ?? null, link: input.link ?? null, automationName: input.automationName ?? null },
  });
  const request = await deps.request(input.missionId, input.key);
  if (!request) throw new Error(`request ${input.key} wasn't recorded`);
  if (request.announcedAt) return fresh ? "created" : "exists";
  // On call: its root post first, and the Mission told once it went (or
  // couldn't). Queued again on a retry, it's the same post.
  if (binding && request.bindingRevision === binding.revision) {
    await deps.queue({
      opKey: `root:${input.missionId}:${input.key}`,
      missionId: input.missionId,
      bindingRevision: binding.revision,
      teamId: binding.teamId,
      channelId: binding.channelId,
      threadTs: null,
      kind: "root",
      payload: { chunks: [rootText(input)] },
      requester: input.requestedBy,
      requestKey: input.key,
    });
    return fresh ? "created" : "exists";
  }
  await announce(request, null, deps);
  return fresh ? "created" : "exists";
}

/** The event that tells the Mission of the request: what was kept of it. */
function requestEvent(request: MissionRequest, threadTs: string | null): RecordedEvent {
  const d = request.details;
  return {
    missionId: request.missionId,
    runnerId: null,
    kind: "request",
    payload: {
      request: {
        source: (request.source ?? "webhook") as RequestSource,
        key: request.requestKey,
        thread: threadTs,
        automation: d?.automationName ?? null,
        title: request.title ?? null,
        text: (d?.text ?? "").slice(0, REQUEST_TEXT_MAX),
        from: d?.from ?? null,
        link: d?.link ?? null,
      },
    },
    key: eventKey.request(request.missionId, request.requestKey),
  };
}

/** Tell the Mission of the request, once. The event first (it's keyed:
 *  twice is once), then the mark, so a crash between the two leaves it for
 *  the tick, which tells it once again. */
async function announce(request: MissionRequest, threadTs: string | null, deps: RequestDeps): Promise<void> {
  await deps.enqueue(requestEvent(request, threadTs));
  await deps.markAnnounced(request.missionId, request.requestKey);
}

/**
 * A request's root post settled: posted (`ts`), or not (failed, dropped,
 * ambiguous). Posted, its message is the request's thread. Either way the
 * Mission is told, with the thread when there is one.
 */
export async function onRootSettled(
  post: Pick<QueuedPost, "missionId" | "teamId" | "channelId" | "requester"> & { requestKey: string },
  ts: string | null,
  deps: RequestDeps,
): Promise<void> {
  const request = await deps.request(post.missionId, post.requestKey);
  if (!request) return;
  let threadTs: string | null = null;
  if (ts) {
    const thread = await deps.acceptThread({ missionId: post.missionId, teamId: post.teamId, channelId: post.channelId, threadTs: ts, startedBy: post.requester });
    await deps.setThread(post.missionId, post.requestKey, thread.id);
    threadTs = ts;
  }
  if (request.announcedAt) return;
  await announce(request, threadTs, deps);
}

/** The tick's part: a request a crash left untold. One whose root post is
 *  still trying is left a while (ten minutes), then told without a thread. */
export async function announceLate(
  request: MissionRequest,
  root: { status: string; createdAt: string } | null,
  deps: RequestDeps,
  now = Date.now(),
): Promise<boolean> {
  if (request.announcedAt) return false;
  if (root?.status === "pending" && now - Date.parse(root.createdAt) < 10 * 60_000) return false;
  const thread = request.threadId ? await deps.thread(request.threadId) : null;
  await announce(request, thread?.threadTs ?? null, deps);
  return true;
}

/** An update to a request (a Linear prompt): the Mission told, once each. */
export async function updateRequest(missionId: string, key: string, update: { id: string; text: string; from?: string | null }, deps: RequestDeps): Promise<"sent" | "cancelled" | "missing"> {
  const request = await deps.request(missionId, key);
  if (!request) return "missing";
  if (request.status === "cancelled") return "cancelled";
  const thread = request.threadId ? await deps.thread(request.threadId) : null;
  await deps.enqueue({
    missionId,
    runnerId: null,
    kind: "request_update",
    payload: {
      request: {
        source: (request.source ?? "linear") as RequestSource,
        key,
        thread: thread?.threadTs ?? null,
        text: update.text.slice(0, REQUEST_TEXT_MAX),
        from: update.from ?? null,
      },
    },
    key: eventKey.requestUpdate(missionId, key, update.id),
  });
  return "sent";
}

/** Cancel a request: its Ships take no more work for it, and the Mission is
 *  told to stop its work. Only this request's. True when it was open. */
export async function cancelRequest(missionId: string, key: string, reason: string, deps: RequestDeps): Promise<boolean> {
  const request = await deps.request(missionId, key);
  if (!request) return false;
  const cancelled = await deps.cancel(missionId, key);
  if (!cancelled) return false;
  await deps.enqueue({
    missionId,
    runnerId: null,
    kind: "request_cancelled",
    payload: { request: { source: (request.source ?? "linear") as RequestSource, key, reason } },
    key: eventKey.requestCancelled(missionId, key),
  });
  return true;
}
