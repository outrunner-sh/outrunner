/**
 * How a person's chats take what they send while the agent works: steered
 * into the running turn (the agent takes it in at its next step), or queued
 * for the turn's end (lib/session/prompt-queue.ts). Steering is on unless they
 * turn it off (Settings → Account → Chats), as Replicas has it.
 *
 * Pure, so it is unit-tested in Node.
 */

import type { AgentId } from "@/lib/agents/registry";

export type ChatPreferences = { steerFollowUps: boolean };

export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = { steerFollowUps: true };

/** Whether an agent takes a prompt into the turn it's running. Claude Code
 *  does (a prompt typed mid-turn joins it at its next tool call); Codex's
 *  handling of one isn't read yet, so its follow-ups queue. */
export function steers(agent: AgentId): boolean {
  return agent === "claude";
}

/**
 * Where a prompt sent now goes: into the running turn (`steer`), to the back
 * of the queue (`queue`), or straight in as the next turn (`send`). Steering
 * only while the agent works on its turn, not while a question or a plan
 * waits on the user, which a prompt answers instead.
 */
export function followUpRoute(state: {
  working: boolean;
  queued: number;
  steerFollowUps: boolean;
  agent: AgentId;
}): "steer" | "queue" | "send" {
  if (state.working && state.steerFollowUps && steers(state.agent)) return "steer";
  if (state.working || state.queued > 0) return "queue";
  return "send";
}
