/**
 * Delivering a question card's answer (CardAnswer) to a session's agent:
 * the exact ask_user call where the agent names its calls
 * (AGENT_FEATURE_ASK_CALL_IDENTITY), by the questions' text where it
 * doesn't. Apart from the route (app/api/workspaces/[id]/answer) so it is
 * unit-tested against a fake agent.
 */
import { AgentRequestError } from "@/lib/runtime/agent-client";
import {
  AGENT_FEATURE_ASK_CALL_IDENTITY,
  type AgentHealth,
  type AnswerRequest,
  type AnswerResponse,
  type CallIdentity,
  type PendingQuestionSummary,
} from "@/lib/runtime/agent-protocol";
import { agentAnswer, answerTarget, type CardAnswer, QUESTION_EXPIRED_MESSAGE } from "@/lib/runtime/pending-question";

/** What delivering an answer needs of the agent (AgentClient's, bound to a
 *  session and chat). */
export type AnswerAgent = {
  health(): Promise<AgentHealth>;
  pendingQuestions(): Promise<PendingQuestionSummary[]>;
  answer(req: AnswerRequest): Promise<AnswerResponse>;
};

/** The answer's outcome: delivered (`replayed` where a retry found it had
 *  been), or refused with the status and message for the caller. */
export type AnswerOutcome =
  | { ok: true; replayed: boolean; named: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string };

/** Refused: a box whose agent can't take an answer for a particular call. */
export const CANT_NAME_CALLS_MESSAGE =
  "This session's box can't take an answer for a particular question yet. Answer it in Outrunner.";

/** Refused: the box didn't say what it can do (its health check failed). */
export const UNREACHABLE_MESSAGE = "Couldn't reach the session's box. Please try again.";

/**
 * Deliver `answer`. A caller naming the call (callId, launchEpoch) gets that
 * call or a 409, never another; a card naming its transcript call
 * (toolUseId) gets the call the agent verified is that one, or a 409 where
 * the agent waits on none or on another. A call the agent couldn't verify
 * yet, an agent from before call identity, or a caller naming nothing, is
 * answered by the questions' text, as before. An answer to a named call
 * lost on the way is sent once more under the same operation id, which the
 * agent delivers at most once. A failure is logged under `workspaceId`.
 */
export async function deliverAnswer(
  agent: AnswerAgent,
  answer: CardAnswer,
  { workspaceId, newOperationId = () => crypto.randomUUID() }: { workspaceId: string; newOperationId?: () => string },
): Promise<AnswerOutcome> {
  const named = answer.callId !== undefined || answer.launchEpoch !== undefined;
  if (named && (answer.callId === undefined || answer.launchEpoch === undefined)) {
    return { ok: false, status: 400, error: "An answer names its call by callId and launchEpoch." };
  }
  if (!named && answer.questions === undefined) {
    return { ok: false, status: 400, error: "That answer isn't one the question takes." };
  }
  try {
    const health = await agent.health().catch(() => null);
    const canName = health?.features?.includes(AGENT_FEATURE_ASK_CALL_IDENTITY) === true;
    let call: CallIdentity | null = null;
    if (named) {
      // A box that didn't answer isn't one that can't name calls: try again.
      if (!health) return { ok: false, status: 502, error: UNREACHABLE_MESSAGE };
      if (!canName) return { ok: false, status: 409, error: CANT_NAME_CALLS_MESSAGE };
      call = { callId: answer.callId!, launchEpoch: answer.launchEpoch! };
    } else if (!health && answer.toolUseId) {
      // A card's answer to a box that didn't say what it can do: try again,
      // rather than answer by the text, which could reach another call.
      return { ok: false, status: 502, error: UNREACHABLE_MESSAGE };
    } else if (canName && answer.toolUseId) {
      const target = answerTarget(await agent.pendingQuestions(), answer.toolUseId);
      if (target.kind === "gone") return { ok: false, status: 409, error: QUESTION_EXPIRED_MESSAGE };
      if (target.kind === "call") call = target.identity;
    }
    const body = agentAnswer(answer, call, answer.answerOperationId ?? newOperationId());
    let result: AnswerResponse;
    try {
      result = await agent.answer(body);
    } catch (error) {
      // Lost on the way (a timeout, a dropped connection): the same
      // operation again is delivered once, or says it was. A legacy answer
      // can't be told from a second one, so it isn't retried.
      const lost = !(error instanceof AgentRequestError) || (error.status >= 502 && !error.error);
      if (!call || !lost) throw error;
      result = await agent.answer(body);
    }
    return { ok: true, replayed: result.replayed === true, named: call !== null };
  } catch (error) {
    // The question is over (answered, given up, asked again, or from before
    // a restart), or the answer doesn't fit it: the agent's message says which.
    if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
      return { ok: false, status: 409, error: error.error.message };
    }
    if (error instanceof AgentRequestError && error.error?.code === "INVALID_REQUEST") {
      return { ok: false, status: 400, error: error.error.message };
    }
    console.error(`Answer: failed for ${workspaceId}`, error);
    return { ok: false, status: 502, error: "Couldn't send your answer. Please try again." };
  }
}
