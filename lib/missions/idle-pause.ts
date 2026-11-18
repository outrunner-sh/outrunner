/**
 * Idle pause (docs/missions.md, "Idle pause"): a Mission on call in a
 * channel where no human has posted anything it hears for 2 weeks offers to
 * pause, and pauses 24 hours later if still no human has. On the Missions
 * tick (lib/missions/tick.ts).
 *
 *   heard      a human message meant for the Mission: a mention, a reply in
 *              a thread it owns that isn't muted, or under its offer; linked
 *              or not. Never `!aside` or a muted thread (people talking to
 *              each other): last_human_at is now, and a pending offer is
 *              called off (slack-route.ts, slack-store.ts heardHuman)
 *   offer      not paused, no offer pending, last_human_at 14 days ago or
 *              more: the offer posted in the channel, idle_warned_at now
 *   pause      offered 24 hours ago or more, no human since: paused and
 *              idle_paused, the pause posted, and the org's audit log has it
 *   resume     by a person (Slack or the header): idle state cleared, and
 *              the 2 weeks start again; a rebind starts fresh too
 *
 * The database does each step as one statement that marks the binding and
 * queues its post (offer_mission_idle_pauses, pause_idle_missions), so racing
 * or retried ticks offer and pause once. `idleStep` says the same in code,
 * for the tests and anyone reading.
 *
 * What touches the world comes in as `deps` (idle-pause.deps.ts).
 */

import type { MissionChannel } from "@/lib/missions/slack-store";

/** No human for this long: the offer. */
export const IDLE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** The offer standing this long with no human: the pause. */
export const IDLE_GRACE_MS = 24 * 60 * 60_000;
/** The most bindings each step takes a tick; the rest go next tick. */
export const IDLE_SWEEP_MAX = 50;

export type IdleFacts = { paused: boolean; lastHumanAt: string; idleWarnedAt: string | null };

/** What the sweep does with a binding now. */
export function idleStep(binding: IdleFacts, now: Date): "none" | "offer" | "pause" {
  if (binding.paused) return "none";
  const lastHuman = Date.parse(binding.lastHumanAt);
  if (binding.idleWarnedAt === null) return now.getTime() - lastHuman >= IDLE_AFTER_MS ? "offer" : "none";
  const warned = Date.parse(binding.idleWarnedAt);
  return now.getTime() - warned >= IDLE_GRACE_MS && lastHuman < warned ? "pause" : "none";
}

export type IdleSweepDeps = {
  /** Mark the bindings due an offer and queue each one's offer, at once. */
  offer(): Promise<MissionChannel[]>;
  /** Pause the bindings whose offer stood with no reply and queue each
   *  one's pause post, at once. */
  pause(): Promise<MissionChannel[]>;
  /** The pause in the org's audit log; best effort. */
  audit(binding: MissionChannel): Promise<void>;
  log(message: string, error: unknown): void;
};

/** One sweep: the pauses due, then the offers due. How many of each. */
export async function sweepIdle(deps: IdleSweepDeps): Promise<{ offered: number; paused: number }> {
  const paused = await deps.pause();
  for (const binding of paused) {
    await deps.audit(binding).catch((error: unknown) => deps.log(`Mission ${binding.missionId}: couldn't audit its idle pause`, error));
  }
  const offered = await deps.offer();
  return { offered: offered.length, paused: paused.length };
}
