/**
 * What a session's agent is doing, folded from its conversation stream one
 * read at a time (lib/session/watch.ts): mid-turn or between turns, what it
 * waits on the user for, and its last reply. The server keeps the result
 * (session_activity) and the stream's cursor, so each read only folds what is
 * new since the last.
 *
 * The rules are the session page's own, so the sidebar and the page agree:
 * working as claudeIsWorking reads it, waiting as pendingToolCall does.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { isInterruption, messageText } from "@/lib/runtime/conversation-events";
import { ASK_TOOL } from "@/lib/runtime/pending-question";
import { SECRETS_TOOL } from "@/lib/runtime/pending-secrets";

/** What the agent can wait on the user for. */
export type Waiting = "question" | "plan" | "secrets";

export type TurnState = {
  turn: "working" | "idle";
  turnStartedAt: string | null;
  waiting: Waiting | null;
  /** The call that waits: its result is the answer. */
  waitingToolId: string | null;
  waitingSince: string | null;
  /** The last turn that ended in a reply. */
  repliedAt: string | null;
  replyPreview: string | null;
  /** When the stream last showed a message. */
  eventAt: string | null;
};

export const IDLE: TurnState = {
  turn: "idle",
  turnStartedAt: null,
  waiting: null,
  waitingToolId: null,
  waitingSince: null,
  repliedAt: null,
  replyPreview: null,
  eventAt: null,
};

/** The tools whose call holds the turn until the user answers. ExitPlanMode
 *  is Claude Code's plan-mode exit, which waits for the plan's approval. */
const WAITS_FOR: Record<string, Waiting> = {
  [ASK_TOOL]: "question",
  [SECRETS_TOOL]: "secrets",
  ExitPlanMode: "plan",
};

/** A reply's opening words, as a notification or a row's tooltip shows them. */
const PREVIEW_CHARS = 280;

export function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** `state` with `events` (the stream's next ones, in order) folded in. */
export function foldEvents(state: TurnState, events: AgentEvent[]): TurnState {
  let next = state;
  for (const event of events) next = foldEvent(next, event);
  return next;
}

function foldEvent(state: TurnState, event: AgentEvent): TurnState {
  if (event.t === "state") {
    // A session that ended is neither working nor waiting, whatever its last
    // turn was.
    if (event.state === "exited" || event.state === "archived") {
      return { ...state, turn: "idle", ...NOT_WAITING };
    }
    return state;
  }
  if (event.t !== "message") return state;
  const at = event.timestamp;

  if (event.role === "user") {
    // The record of a stop ends the turn, and any call it was waiting on.
    if (isInterruption(event)) return { ...state, turn: "idle", eventAt: at, ...NOT_WAITING };
    // A prompt starts a turn; any call still waiting is over (pendingToolCall).
    if (messageText(event) !== "") {
      return { ...state, turn: "working", turnStartedAt: at, eventAt: at, ...NOT_WAITING };
    }
    // A tool result, for Claude to act on: the answer, if it's the waited call's.
    const answered = event.content.some(
      (block) => block.type === "tool_result" && block.toolUseId === state.waitingToolId,
    );
    return {
      ...state,
      turn: "working",
      turnStartedAt: state.turn === "working" ? state.turnStartedAt : at,
      eventAt: at,
      ...(answered && NOT_WAITING),
    };
  }

  let next: TurnState = { ...state, eventAt: at };
  for (const block of event.content) {
    if (block.type !== "tool_use") continue;
    const waiting = WAITS_FOR[block.name];
    if (waiting) next = { ...next, waiting, waitingToolId: block.id, waitingSince: at };
  }
  const last = event.content[event.content.length - 1];
  // A reply that ends in words is the turn over, unless it stopped for a
  // tool call (claudeIsWorking's rule).
  if (last?.type === "text" && event.stopReason !== "tool_use") {
    const text = messageText(event);
    return { ...next, turn: "idle", repliedAt: at, replyPreview: text ? preview(text) : next.replyPreview };
  }
  return {
    ...next,
    turn: "working",
    turnStartedAt: state.turn === "working" ? state.turnStartedAt : at,
  };
}

const NOT_WAITING = { waiting: null, waitingToolId: null, waitingSince: null } as const;
