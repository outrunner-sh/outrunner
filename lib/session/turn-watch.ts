/**
 * Watching a session's agent for the end of its turn: the Slack relay
 * (lib/slack/relay.ts) for a thread's reply, and Missions
 * (lib/missions/watch.ts) for a Runner's turn. The parts with no network.
 *
 * A turn is over when the agent says it isn't mid-turn (the box's activity:
 * its last message is a reply with no tool call open, so a subagent at work,
 * or any tool, keeps it open), it has replied since the send, it has been
 * quiet a while, and all of that holds on a second look some seconds later:
 * a pause between one tool call and the next isn't an end. A background task
 * the agent started finishing later starts a turn of its own, which no watch
 * awaits.
 */

import type { WorkspaceStatus } from "@/lib/runtime/types";

/** Quiet this long after its last activity, a session's turn is over. */
export const QUIET_MS = 20_000;
/** An end seen once is confirmed by a second look this much later. */
export const CONFIRM_MS = 15_000;
/** A box that doesn't answer this long, while its session says it's up, has
 *  died. */
export const UNREACHABLE_MS = 5 * 60_000;
/** A send the agent hasn't started on in this long didn't reach it. */
export const NEVER_STARTED_MS = 10 * 60_000;

/**
 * Whether the reply to what was sent at `since` is over, by the summary
 * alone: there's a reply, the session was active after the send (so it's
 * this turn's, not an older one a slow wake left showing), and it has gone
 * quiet. For a box that can't say whether it's mid-turn.
 */
export function turnOver(
  summary: { lastAssistantMessage: string | null; lastActivity: string },
  since = 0,
  now = Date.now(),
): boolean {
  if (!summary.lastAssistantMessage?.trim()) return false;
  const last = Date.parse(summary.lastActivity);
  return Number.isFinite(last) && last > since && now - last >= QUIET_MS;
}

/** Look every `everyMs` until `check` is done or `forMs` has passed. */
export async function watchUntil(
  check: () => Promise<boolean>,
  { forMs, everyMs, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }: {
    forMs: number;
    everyMs: number;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  },
): Promise<boolean> {
  const until = now() + forMs;
  while (now() < until) {
    await sleep(everyMs);
    if (await check().catch(() => false)) return true;
  }
  return false;
}

/** What a watch knows between looks (turn_watches). Times in ms. */
export type WatchState = {
  sentAt: number;
  /** The box's last activity before the send, by its own clock; null when
   *  unknown (then `sentAt`, by ours). */
  baselineActivity: number | null;
  seenWorking: boolean;
  quietSince: number | null;
  /** The box's last-activity stamp at that first look: the end is
   *  confirmed only if it hasn't moved, which needs no clock of ours to agree
   *  with the box's. */
  quietActivity: string | null;
  lastMessage: string | null;
  unreachableSince: number | null;
};

/** One look at the session. */
export type TurnObservation = {
  now: number;
  status: WorkspaceStatus;
  errorMessage?: string | null;
  /** Whether its box answered. */
  reachable: boolean;
  /** Whether its agent is mid-turn; null for a box that can't say. */
  working: boolean | null;
  summary: { lastAssistantMessage: string | null; lastActivity: string; state: string } | null;
};

export type TurnVerdict =
  /** Look again later, with what's known now. */
  | { kind: "waiting"; state: WatchState }
  /** The turn ended: its reply, if it could be read. */
  | { kind: "over"; message: string | null; asleep: boolean }
  /** It won't end: the session failed, or its box or agent died. */
  | { kind: "lost"; cause: string }
  /** Nothing more to watch (archived or deleted on purpose). */
  | { kind: "closed" };

/** Where the turn stands after this look. */
export function observeTurn(watch: WatchState, look: TurnObservation): TurnVerdict {
  const waiting = (patch: Partial<WatchState> = {}): TurnVerdict => ({ kind: "waiting", state: { ...watch, ...patch } });
  switch (look.status) {
    case "creating":
    case "provisioning":
    case "resuming":
    case "restoring":
      return waiting({ unreachableSince: null });
    case "archiving":
    case "archived":
    case "destroying":
    case "destroyed":
      return { kind: "closed" };
    case "failed":
      return { kind: "lost", cause: look.errorMessage ? `its session failed: ${look.errorMessage}` : "its session failed" };
    case "suspending":
    case "suspended":
      // Only a box with no turn running is paused: the turn ended, with the
      // reply last read.
      return { kind: "over", message: watch.lastMessage, asleep: true };
    default:
      break;
  }
  if (!look.reachable || !look.summary) {
    const since = watch.unreachableSince ?? look.now;
    if (look.now - since >= UNREACHABLE_MS) return { kind: "lost", cause: "its box stopped answering" };
    return waiting({ unreachableSince: since });
  }
  const summary = look.summary;
  const reply = summary.lastAssistantMessage?.trim() ? summary.lastAssistantMessage : null;
  const seen = { unreachableSince: null, lastMessage: reply ?? watch.lastMessage };
  if (summary.state === "exited" || summary.state === "degraded") {
    return { kind: "lost", cause: summary.state === "exited" ? "its agent exited" : "its agent is in a degraded state" };
  }
  if (look.working === true) return waiting({ ...seen, seenWorking: true, quietSince: null, quietActivity: null });

  const last = Date.parse(summary.lastActivity);
  const activeSince = Number.isFinite(last) && last > (watch.baselineActivity ?? watch.sentAt);
  const started = watch.seenWorking || activeSince;
  if (!started) {
    if (look.now - watch.sentAt >= NEVER_STARTED_MS) return { kind: "lost", cause: "it never started on its message" };
    return waiting({ ...seen, quietSince: null, quietActivity: null });
  }
  // Not mid-turn, with a reply. A box that can't say whether it's mid-turn
  // (an older agent) is judged by its summary going quiet instead.
  const ended =
    reply !== null && (look.working === false || turnOver(summary, watch.baselineActivity ?? watch.sentAt, look.now));
  if (!ended) return waiting({ ...seen, quietSince: null, quietActivity: null });
  if (watch.quietSince === null || watch.quietActivity !== summary.lastActivity) {
    // First seen ended, or something happened since it was: look again.
    return waiting({ ...seen, quietSince: look.now, quietActivity: summary.lastActivity });
  }
  if (look.now - watch.quietSince < CONFIRM_MS) return waiting(seen);
  return { kind: "over", message: reply, asleep: false };
}
