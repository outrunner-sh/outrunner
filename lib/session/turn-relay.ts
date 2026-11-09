/**
 * Passing a session's reply on to wherever it was asked from (a Slack thread, a
 * Linear agent session): once its turn is over, its last message, once.
 *
 * Knows nothing of where it goes: each caller says how to load what's awaited,
 * claim a reply (so an overlapping watch or tick posts nothing), put it back when
 * posting failed, and post it.
 */

import { createHash } from "node:crypto";

import { turnOver } from "@/lib/session/turn-watch";

export type TurnSummary = { lastAssistantMessage: string | null; lastActivity: string };

/** What's awaited; null when there's nothing left to wait for. */
export type AwaitedReply = { relayedHash: string | null; relayUntil: string | null };

export type RelayTarget = {
  load(): Promise<AwaitedReply | null>;
  summary(): Promise<TurnSummary | null>;
  /** Take this reply; false when it was already posted. Clears what's awaited. */
  claim(digest: string): Promise<boolean>;
  /** The same reply as last time: nothing new, and nothing left to wait for. */
  clear(): Promise<void>;
  /** Not posted: give the claim back, so the next look tries again. */
  restore(previous: AwaitedReply): Promise<void>;
  post(message: string): Promise<void>;
};

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Post the reply if the turn is over and it hasn't been posted. True when it was,
 * or there's nothing left to wait for; false to keep waiting. `awaitMs` is how long
 * a reply is waited for: what was said before relayUntil minus that isn't this turn's.
 */
export async function relayTurn(target: RelayTarget, awaitMs: number, now = Date.now()): Promise<boolean> {
  const awaited = await target.load();
  if (!awaited) return true;
  const since = awaited.relayUntil ? Date.parse(awaited.relayUntil) - awaitMs : 0;
  const summary = await target.summary();
  if (!summary || !turnOver(summary, since, now)) return false;
  const message = summary.lastAssistantMessage as string;
  if (!(await target.claim(hash(message)))) {
    await target.clear();
    return true;
  }
  try {
    await target.post(message);
  } catch (error) {
    await target.restore(awaited);
    throw error;
  }
  return true;
}
