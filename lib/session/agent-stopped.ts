/**
 * A session's agent that stopped on its box (it crashed, or was killed as the
 * box ran out of memory), as its conversation stream says: the box's
 * "exited", with why where it can tell. Pure, for the session page and tests.
 */

import { type AgentEvent, EXIT_OUT_OF_MEMORY } from "@/lib/runtime/agent-protocol";
import { type PendingPrompt, pendingShows } from "@/lib/session/optimistic-echo";

export type AgentStopped = { outOfMemory: boolean };

/** The agent's stop, while the stream's word on the session is that it
 *  exited; null while it runs (or was started again: "running" follows). The
 *  page keeps one state event, the latest (appendEvent). */
export function agentStopped(events: readonly AgentEvent[]): AgentStopped | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t !== "state") continue;
    return event.state === "exited" ? { outOfMemory: event.reason === EXIT_OUT_OF_MEMORY } : null;
  }
  return null;
}

/** What the session page says of it, under "<agent> stopped". */
export function stoppedDetail(stopped: AgentStopped): string {
  const why = stopped.outOfMemory
    ? "Its box ran out of memory, and it was stopped partway through."
    : "It exited partway through.";
  return `${why} Restart it to carry on: it picks up the conversation, but the step it was on is lost.`;
}

/** The prompts the page handed to the agent that its conversation never
 *  recorded: with the agent stopped, they won't be, so they are said not
 *  delivered rather than left as bubbles that never land. */
export function undeliveredPrompts(pending: readonly PendingPrompt[], delivered: number): PendingPrompt[] {
  return pending.filter((p) => p.expect !== null && pendingShows(p, delivered));
}

/** The box's refusal of an edit while its agent works (its ErrRewindBusy):
 *  the page offers Stop then, whatever it reads of the turn. */
export function isBusyRefusal(message: string): boolean {
  return message.startsWith("the agent is working");
}
