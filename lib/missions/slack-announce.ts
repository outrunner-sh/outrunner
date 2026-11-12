/**
 * A Ship's news told in the Slack thread of the request it was started for
 * (docs/missions.md, "On call in Slack"), by the system rather than the
 * Mission: each of its pull requests opened, ready, merged or closed, as a
 * compact card (the Slack agent's own pull request line,
 * lib/slack/announce-pull-request.ts). A thread can hold several requests,
 * each several Ships, each several pull requests: every card is keyed by its
 * own Ship, pull request and event, so none is taken for another, and none
 * assumes one pull request a thread. Cards go through the post queue
 * (lib/missions/slack-outbox.ts) under the binding the Ship was started
 * under: after an unbind or a rebind they're dropped, never moved.
 *
 * And a Mission whose `ask_user` waits on its owner says so in its latest
 * thread.
 */

import type { MissionEventKind, MissionEventPayload, PullRequestRef } from "@/lib/missions/events";
import type { QueueOutcome, QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionRequest, MissionThread, ShipLedger } from "@/lib/missions/slack-store";
import { pullRequestCard } from "@/lib/missions/slack-text";

export type AnnounceDeps = {
  ledger(runnerId: string): Promise<ShipLedger | null>;
  binding(missionId: string): Promise<MissionChannel | null>;
  latestThread(binding: MissionChannel): Promise<MissionThread | null>;
  latestRequest(threadId: string): Promise<MissionRequest | null>;
  queue(post: QueuedPost): Promise<QueueOutcome>;
};

export type CardKind = "opened" | "ready" | "merged" | "closed";

/** Each card's key: one a Ship, a pull request and what happened to it.
 *  `ready` can come again (after a fix): each decision is its own. */
export function cardKey(kind: CardKind, runnerId: string, pr: { repo: string; number: number }, eventKey?: string): string {
  const which = `${pr.repo.toLowerCase()}#${pr.number}`;
  return kind === "ready" && eventKey ? `card:ready:${runnerId}:${which}:${eventKey}` : `card:${kind}:${runnerId}:${which}`;
}

/** The Ship's thread and the binding its cards go under, if it has one. */
async function shipPlace(missionId: string, runnerId: string, deps: AnnounceDeps): Promise<{ ledger: ShipLedger; thread: MissionThread; revision: string } | null> {
  const ledger = await deps.ledger(runnerId);
  const thread = ledger?.thread;
  if (!ledger || !thread || thread.missionId !== missionId) return null;
  let revision = ledger.bindingRevision;
  if (!revision) {
    // A Ship from before revisions: the binding now, if it's that channel.
    const binding = await deps.binding(missionId);
    if (!binding || binding.teamId !== thread.teamId || binding.channelId !== thread.channelId) return null;
    revision = binding.revision;
  }
  return { ledger, thread, revision };
}

/** A card about one of a Ship's pull requests, queued in its thread; true
 *  when it was queued now. */
export async function announcePullRequest(
  input: { missionId: string; runnerId: string; kind: CardKind; pr: PullRequestRef; ship: string; eventKey?: string },
  deps: AnnounceDeps,
): Promise<boolean> {
  const place = await shipPlace(input.missionId, input.runnerId, deps);
  if (!place || place.thread.muted) return false;
  return (await deps.queue({
    opKey: cardKey(input.kind, input.runnerId, input.pr, input.eventKey),
    missionId: input.missionId,
    bindingRevision: place.revision,
    teamId: place.thread.teamId,
    channelId: place.thread.channelId,
    threadTs: place.thread.threadTs,
    kind: "card",
    payload: { chunks: [pullRequestCard(input.kind, input.pr, input.ship)] },
    requester: place.ledger.requestedBy,
  })) === "queued";
}

/** A Ship's event, as a card in its thread if it's one Slack hears. */
export async function announceShipEvent(
  event: { missionId: string; runnerId: string | null; kind: MissionEventKind; payload: MissionEventPayload; key: string },
  deps: AnnounceDeps,
): Promise<boolean> {
  if (!event.runnerId || !event.payload.pr) return false;
  if (event.kind !== "ready" && event.kind !== "merged" && event.kind !== "closed") return false;
  return announcePullRequest(
    { missionId: event.missionId, runnerId: event.runnerId, kind: event.kind, pr: event.payload.pr, ship: event.payload.runner ?? "Ship", eventKey: event.key },
    deps,
  );
}

/** The Mission waits on its owner's decision (its ask_user card): its
 *  latest thread hears so, with where to answer, once a wait (`waitKey`). */
export async function announceWaiting(missionId: string, waitKey: string, url: string | null, deps: AnnounceDeps): Promise<boolean> {
  const binding = await deps.binding(missionId);
  if (!binding) return false;
  const thread = await deps.latestThread(binding);
  if (!thread || thread.muted) return false;
  const request = await deps.latestRequest(thread.id);
  return (await deps.queue({
    opKey: `waiting:${missionId}:${waitKey}`,
    missionId,
    bindingRevision: binding.revision,
    teamId: binding.teamId,
    channelId: binding.channelId,
    threadTs: thread.threadTs,
    kind: "card",
    payload: { chunks: [`:raised_hand: The Mission is waiting on a decision from its owner before it goes on${url ? `: <${url}|answer in Outrunner>` : "."}`] },
    requester: request?.requestedBy ?? thread.startedBy,
  })) === "queued";
}
