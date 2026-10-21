/**
 * The question a session's agent is waiting on the user to answer: its call of
 * Outrunner's ask_user tool (runtime-agent/internal/ask) that has no result
 * yet. The composer gives way to a card for it (components/question-card.tsx).
 *
 * Pure (no React), so it is unit-tested in Node.
 */
import { z } from "zod";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { messageText } from "@/lib/runtime/conversation-events";

/** The tool as Claude names it: mcp__<server>__<tool>. */
export const ASK_TOOL = "mcp__outrunner__ask_user";

/** An option a model sent as a bare string ("Yes") is read as its label, as
 *  the agent reads it (ask.Option.UnmarshalJSON). */
const AskOption = z.union([
  z.string().transform((label) => ({ label, description: undefined })),
  z.object({ label: z.string(), description: z.string().optional() }),
]);

const AskQuestion = z.object({
  header: z.string().optional(),
  question: z.string(),
  options: z.array(AskOption).min(1),
  multiSelect: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

const AskInput = z.object({ questions: z.array(AskQuestion).min(1).max(4) });

export type PendingQuestion = {
  /** The tool call's id: the card it shows is answered once. */
  toolUseId: string;
  questions: AskQuestion[];
  /** The questions exactly as the agent asked them, sent back with the
   *  answer: the agent matches them to the call that is waiting. */
  raw: unknown;
};

/** The user's answer to one question: the options picked, by label, and what
 *  they typed into "Other". */
export type AskAnswer = { selected: string[]; other: string };

/**
 * The newest ask_user call still waiting on an answer, or null. A call is
 * answered once its result is in the stream; one followed by a prompt, a
 * stopped turn or the session's end is over, whatever the agent recorded (a
 * session killed mid-question records no result).
 */
export function pendingQuestion(events: AgentEvent[]): PendingQuestion | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t === "state") {
      if (event.state === "exited" || event.state === "archived") return null;
      continue;
    }
    if (event.t !== "message") continue;
    if (event.role === "user") {
      if (messageText(event) !== "") return null; // a prompt, or the record of a stop
      continue;
    }
    for (let b = event.content.length - 1; b >= 0; b--) {
      const block = event.content[b];
      if (block.type !== "tool_use" || block.name !== ASK_TOOL) continue;
      if (answered(events, i, block.id)) return null;
      const parsed = AskInput.safeParse(block.input);
      if (!parsed.success) return null; // the agent refuses it too: no card to answer
      return {
        toolUseId: block.id,
        questions: parsed.data.questions,
        raw: (block.input as { questions: unknown }).questions,
      };
    }
  }
  return null;
}

function answered(events: AgentEvent[], from: number, toolUseId: string): boolean {
  return events
    .slice(from)
    .some(
      (event) =>
        event.t === "message" &&
        event.content.some((block) => block.type === "tool_result" && block.toolUseId === toolUseId),
    );
}

/** Whether an answer can be sent: something picked or typed, and only one
 *  thing for a question that takes one. */
export function isAnswered(question: AskQuestion, answer: AskAnswer | undefined): boolean {
  if (!answer) return false;
  const typed = answer.other.trim() !== "";
  const count = answer.selected.length + (typed ? 1 : 0);
  return question.multiSelect ? count > 0 : count === 1;
}

/** What the agent says to an answer for a question no call waits on any more
 *  (ask.ErrNotWaiting): answered already, given up, or from before a restart.
 *  The desktop app passes the agent's message through as the error. */
export const QUESTION_EXPIRED_MESSAGE = "this question is no longer waiting for an answer";

/** Whether a failed answer failed because the question is over, so the card
 *  goes for good rather than being offered again. */
export function isExpiredQuestionError(message: string): boolean {
  return message.toLowerCase().includes(QUESTION_EXPIRED_MESSAGE);
}
