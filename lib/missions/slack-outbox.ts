/**
 * Posts in Slack for a Mission on call, through a stored queue
 * (mission_slack_posts, 20261112210000_mission_slack_reliability.sql): its
 * replies and question cards, its reactions, and the cards the system posts
 * for it (a Ship's pull requests, a wait on its owner). Each post has a
 * stable key, so queueing it twice is one post; it's taken under a lease,
 * right after it's queued and by the tick, the oldest of each thread first.
 *
 * Right before it goes, it's checked again (docs/missions.md, "Reliability"):
 *
 *   binding    the Mission still on call in that channel, under the same
 *              revision it was queued under: never moved to a channel bound
 *              since, nor posted after an unbind
 *   thread     not muted
 *   requester  whoever's request it answers can still read the project
 *   pause      not checked: a paused Mission still reports on work it had
 *              started (decision 3 of PR #418)
 *
 * Sending: a long reply goes as chunks, each recorded as it goes, so a
 * crash resumes at the next. Slack's rate limit waits its Retry-After;
 * other failures back off (15 seconds, doubling, to ten minutes). A send
 * Slack never answered (a timeout) may have posted: the next try looks for
 * the post's marker (in its metadata) in the thread first, and if the thread
 * can't settle it, the post is marked ambiguous, never posted again blindly.
 *
 * What touches the world comes in as `deps` (slack-outbox.deps.ts).
 */

import type { MissionChannel } from "@/lib/missions/slack-store";
import type { Workspace } from "@/lib/runtime/types";
import { SlackApiError, SlackUnknownOutcomeError } from "@/lib/slack/web";

export type SlackBlocks = Record<string, unknown>[];

export type PostPayload =
  /** A reply or a card: its mrkdwn chunks, posted in order. */
  | { chunks: string[] }
  /** A question card, and its row (mission_slack_asks). */
  | { text: string; blocks: SlackBlocks; askId: string }
  /** A reaction on a message of the thread. */
  | { ts: string; name: string };

/** A post, as it's queued. */
export type QueuedPost = {
  opKey: string;
  missionId: string;
  bindingRevision: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  kind: "reply" | "ask" | "reaction" | "card";
  payload: PostPayload;
  requester: string | null;
};

/** A post taken from the queue. */
export type ClaimedPost = QueuedPost & {
  id: string;
  attempt: number;
  progress: number;
  postedTs: string[];
  inDoubt: boolean;
};

export type PostOutcome =
  | { status: "sent"; postedTs: string[] }
  | { status: "retry"; error: string; delaySeconds: number; inDoubt: boolean; progress: number; postedTs: string[] }
  | { status: "ambiguous" | "failed" | "dropped"; error: string; progress: number; postedTs: string[] };

export type OutboxPostDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  muted(teamId: string, channelId: string, threadTs: string): Promise<boolean>;
  mission(id: string): Promise<Workspace | null>;
  canRead(userId: string, mission: Workspace): Promise<boolean>;
  /** Post with a marker; Slack's ts. Throws SlackApiError, or
   *  SlackUnknownOutcomeError when Slack didn't answer. */
  post(post: QueuedPost, message: { text: string; blocks?: SlackBlocks; marker: string }): Promise<string>;
  react(post: QueuedPost, ts: string, name: string): Promise<void>;
  /** The markers of the bot's posts in the thread, and whether all were read. */
  markers(post: QueuedPost): Promise<{ markers: Map<string, string>; complete: boolean }>;
  /** A chunk posted: recorded before the next goes. */
  progressed(post: ClaimedPost, progress: number, postedTs: string[]): Promise<void>;
  /** A question card posted: its message, for the click to update. */
  askPosted?(askId: string, ts: string): Promise<void>;
};

/** What queueing a post came to: queued now (new, or one that had failed or
 *  been dropped, queued again); queued before and still to go; sent before;
 *  or sent with no answer, so not to be posted again blindly. */
export type QueueOutcome = "queued" | "already_pending" | "already_sent" | "ambiguous";

/** How many tries a post gets. */
export const MAX_POST_ATTEMPTS = 8;

/** Slack's answers that no retry changes. */
const FATAL = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "msg_too_long",
  "invalid_blocks",
  "no_text",
  "message_not_found",
  "thread_not_found",
  "invalid_name",
  "invalid_arguments",
  "invalid_blocks_format",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "metadata_too_large",
  "too_many_attachments",
  "cannot_reply_to_message",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_non_threadable_channel",
]);

export function backoffSeconds(attempt: number): number {
  return Math.min(600, 15 * 2 ** Math.min(Math.max(attempt - 1, 0), 10));
}

/** Each chunk's marker: the post's key and the chunk's place. */
export function chunkMarker(opKey: string, index: number): string {
  return `${opKey}#${index}`;
}

function messages(payload: PostPayload): { text: string; blocks?: SlackBlocks }[] {
  if ("chunks" in payload) return payload.chunks.map((text) => ({ text }));
  if ("blocks" in payload) return [{ text: payload.text, blocks: payload.blocks }];
  return [];
}

/** Whether the post may still go, and why not. */
async function recheck(post: ClaimedPost, deps: OutboxPostDeps): Promise<string | null> {
  const binding = await deps.binding(post.missionId);
  if (!binding) return "the Mission is no longer on call";
  if (binding.revision !== post.bindingRevision || binding.teamId !== post.teamId || binding.channelId !== post.channelId) {
    return "the Mission was put on call again since (another binding): queued posts aren't moved to it";
  }
  if (await deps.muted(post.teamId, post.channelId, post.threadTs)) return "the thread is muted";
  const mission = await deps.mission(post.missionId);
  if (!mission || mission.kind !== "mission" || mission.status === "destroying" || mission.status === "destroyed") return "the Mission is gone";
  if (post.requester && !(await deps.canRead(post.requester, mission))) return "the person who asked can no longer read the project";
  return null;
}

/** Deliver one claimed post: what came of it, for the queue to record. */
export async function deliverPost(post: ClaimedPost, deps: OutboxPostDeps): Promise<PostOutcome> {
  let progress = post.progress;
  const postedTs = [...post.postedTs];
  const done = (status: "ambiguous" | "failed" | "dropped", error: string): PostOutcome => ({ status, error, progress, postedTs });

  const why = await recheck(post, deps);
  if (why) return done("dropped", why);

  if ("name" in post.payload) {
    try {
      await deps.react(post, post.payload.ts, post.payload.name);
      return { status: "sent", postedTs: [] };
    } catch (error) {
      // A reaction is the same however often it's added: tried again, never
      // in doubt.
      return failure(post, error, { progress, postedTs, inDoubt: false });
    }
  }

  const all = messages(post.payload);
  // The last send wasn't answered: is it in the thread?
  if (post.inDoubt) {
    let found: { markers: Map<string, string>; complete: boolean };
    try {
      found = await deps.markers(post);
    } catch (error) {
      return done("ambiguous", `a send went unanswered, and the thread couldn't be read to check it: ${message(error)}`);
    }
    const ts = found.markers.get(chunkMarker(post.opKey, progress));
    if (ts) {
      postedTs.push(ts);
      progress++;
      await deps.progressed(post, progress, postedTs);
    } else if (!found.complete) {
      return done("ambiguous", "a send went unanswered, and the thread is too long to tell whether it posted");
    }
  }

  while (progress < all.length) {
    const marker = chunkMarker(post.opKey, progress);
    try {
      const ts = await deps.post(post, { ...all[progress], marker });
      postedTs.push(ts);
      progress++;
      await deps.progressed(post, progress, postedTs);
    } catch (error) {
      return failure(post, error, { progress, postedTs, inDoubt: error instanceof SlackUnknownOutcomeError });
    }
  }
  if ("askId" in post.payload && postedTs[0]) await deps.askPosted?.(post.payload.askId, postedTs[0]).catch(() => undefined);
  return { status: "sent", postedTs };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(post: ClaimedPost, error: unknown, at: { progress: number; postedTs: string[]; inDoubt: boolean }): PostOutcome {
  const text = message(error);
  if (error instanceof SlackApiError && FATAL.has(error.code)) return { status: "failed", error: text, progress: at.progress, postedTs: at.postedTs };
  if (post.attempt >= MAX_POST_ATTEMPTS) {
    // Out of tries with the last send's outcome unknown: not "failed", which
    // would say it never posted.
    return { status: at.inDoubt ? "ambiguous" : "failed", error: `gave up after ${post.attempt} tries: ${text}`, progress: at.progress, postedTs: at.postedTs };
  }
  const retryAfter = error instanceof SlackApiError && error.retryAfter ? error.retryAfter : 0;
  return {
    status: "retry",
    error: text,
    delaySeconds: Math.max(retryAfter, error instanceof SlackApiError && error.code === "ratelimited" ? 1 : backoffSeconds(post.attempt)),
    inDoubt: at.inDoubt,
    progress: at.progress,
    postedTs: at.postedTs,
  };
}
