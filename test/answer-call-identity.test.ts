import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import {
  AGENT_FEATURE_ASK_CALL_IDENTITY,
  AnswerRequest,
  AnswerResponse,
  PendingQuestionsResponse,
  type AnswerRequest as AnswerRequestType,
  type PendingQuestionSummary,
} from "@/lib/runtime/agent-protocol";
import { CANT_NAME_CALLS_MESSAGE, deliverAnswer, UNREACHABLE_MESSAGE, type AnswerAgent } from "@/lib/runtime/answer-question";
import { agentAnswer, answerTarget, CardAnswer, QUESTION_EXPIRED_MESSAGE } from "@/lib/runtime/pending-question";

const questions = [{ question: "Where?", options: ["DB", { label: "Facts" }] }];
const answers = [{ selected: ["DB"], other: "" }];
const waiting = (over: Partial<PendingQuestionSummary> = {}): PendingQuestionSummary => ({
  callId: "c1",
  launchEpoch: "e1",
  workspaceId: "ws",
  chat: "main",
  toolUseId: "toolu_1",
  questions,
  ...over,
});

/** A fake agent: its features, the calls it lists, and what it does with an
 *  answer; it records every answer sent. */
function fakeAgent(opts: {
  features?: string[];
  listed?: PendingQuestionSummary[];
  answer?: (req: AnswerRequestType, n: number) => Promise<unknown>;
}): AnswerAgent & { sent: AnswerRequestType[] } {
  const sent: AnswerRequestType[] = [];
  return {
    sent,
    health: async () => ({ status: "ok", features: opts.features }),
    pendingQuestions: async () => opts.listed ?? [],
    answer: async (req) => {
      sent.push(AnswerRequest.parse(req));
      const out = opts.answer ? await opts.answer(req, sent.length) : { result: "answered" };
      return AnswerResponse.parse(out);
    },
  };
}

const NAMES = [AGENT_FEATURE_ASK_CALL_IDENTITY];
const WS = { workspaceId: "ws" };

test("the answer request names a call fully, or names its questions", () => {
  assert.equal(AnswerRequest.safeParse({ questions, answers }).success, true);
  assert.equal(AnswerRequest.safeParse({ answers, callId: "c", launchEpoch: "e", answerOperationId: "op" }).success, true);
  assert.equal(AnswerRequest.safeParse({ answers, callId: "c", launchEpoch: "e" }).success, false);
  assert.equal(AnswerRequest.safeParse({ answers, callId: "c" }).success, false);
  assert.equal(AnswerRequest.safeParse({ answers }).success, false);
  assert.deepEqual(AnswerResponse.parse({ result: "answered", replayed: true }), { result: "answered", replayed: true });
  assert.deepEqual(AnswerResponse.parse({ result: "answered" }), { result: "answered" });
  const listed = PendingQuestionsResponse.parse({ questions: [{ callId: "c", launchEpoch: "e", workspaceId: "ws", chat: "main", questions }] });
  assert.equal(listed.questions[0].toolUseId, undefined);
});

test("an answer targets the call verified to be the card's", () => {
  assert.deepEqual(answerTarget([waiting()], "toolu_1"), { kind: "call", identity: { callId: "c1", launchEpoch: "e1" } });
  // Over: nothing waits, or another verified call does (the same text asked again).
  assert.deepEqual(answerTarget([], "toolu_1"), { kind: "gone" });
  assert.deepEqual(answerTarget([waiting({ toolUseId: "toolu_2", callId: "c2" })], "toolu_1"), { kind: "gone" });
  // Waiting, but not tied to the transcript yet: as before, by text.
  assert.deepEqual(answerTarget([waiting({ toolUseId: undefined })], "toolu_1"), { kind: "legacy" });
});

test("the agent's request carries the identity, or only the questions", () => {
  const card = CardAnswer.parse({ questions, answers, toolUseId: "toolu_1" });
  assert.deepEqual(agentAnswer(card, { callId: "c1", launchEpoch: "e1" }, "op"), {
    questions,
    answers,
    callId: "c1",
    launchEpoch: "e1",
    answerOperationId: "op",
  });
  assert.deepEqual(agentAnswer(card, null, "op"), { questions, answers });
  assert.deepEqual(agentAnswer({ ...card, dismissed: true }, null, "op"), { questions, dismissed: true });
});

test("a card's answer goes to its verified call, under one operation", async () => {
  const agent = fakeAgent({ features: NAMES, listed: [waiting()] });
  const out = await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1" }, { workspaceId: "ws", newOperationId: () => "op-1" });
  assert.deepEqual(out, { ok: true, replayed: false, named: true });
  assert.equal(agent.sent[0].callId, "c1");
  assert.equal(agent.sent[0].launchEpoch, "e1");
  assert.equal(agent.sent[0].answerOperationId, "op-1");
});

test("a card for a call that is over is refused, not given to the next one asking the same", async () => {
  const agent = fakeAgent({ features: NAMES, listed: [waiting({ toolUseId: "toolu_2", callId: "c2" })] });
  const out = await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1" }, WS);
  assert.deepEqual(out, { ok: false, status: 409, error: QUESTION_EXPIRED_MESSAGE });
  assert.equal(agent.sent.length, 0);
});

test("a stale identity the agent refuses is a 409", async () => {
  const agent = fakeAgent({
    features: NAMES,
    answer: async () => {
      throw new AgentRequestError(409, { code: "CONFLICT", message: "this question is no longer waiting for an answer (stale)" });
    },
  });
  const out = await deliverAnswer(agent, { answers, callId: "c1", launchEpoch: "old", answerOperationId: "op" }, WS);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.status, 409);
});

test("an answer lost on the way is retried once under the same operation, and reconciles", async () => {
  const agent = fakeAgent({
    features: NAMES,
    listed: [waiting()],
    answer: async (_req, n) => {
      if (n === 1) throw new TypeError("fetch failed: timeout");
      return { result: "answered", replayed: true };
    },
  });
  const out = await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1", answerOperationId: "op-9" }, WS);
  assert.deepEqual(out, { ok: true, replayed: true, named: true });
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[0].answerOperationId, "op-9");
  assert.equal(agent.sent[1].answerOperationId, "op-9");
});

test("legacy: an agent without call identity is answered by text, and never retried", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const agent = fakeAgent({
    features: ["request-secrets"],
    answer: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const out = await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1", answerOperationId: "op" }, WS);
  assert.deepEqual(out, { ok: false, status: 502, error: "Couldn't send your answer. Please try again." });
  assert.deepEqual(agent.sent, [{ questions, answers }]);
  // The failure names the session it was for.
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[0], "Answer: failed for ws");
});

test("legacy: a client naming nothing is answered by text, even by an agent that names calls", async () => {
  const agent = fakeAgent({ features: NAMES, listed: [waiting()] });
  const out = await deliverAnswer(agent, { questions, answers }, WS);
  assert.deepEqual(out, { ok: true, replayed: false, named: false });
  assert.deepEqual(agent.sent, [{ questions, answers }]);
});

test("legacy: a call the agent hasn't tied to the transcript is answered by text", async () => {
  const agent = fakeAgent({ features: NAMES, listed: [waiting({ toolUseId: undefined })] });
  const out = await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1" }, WS);
  assert.deepEqual(out, { ok: true, replayed: false, named: false });
  assert.deepEqual(agent.sent, [{ questions, answers }]);
});

test("a named call is refused by an agent that can't take one, rather than answered by text", async () => {
  const agent = fakeAgent({ features: [] });
  const out = await deliverAnswer(agent, { answers, callId: "c1", launchEpoch: "e1" }, WS);
  assert.deepEqual(out, { ok: false, status: 409, error: CANT_NAME_CALLS_MESSAGE });
  assert.equal(agent.sent.length, 0);
});

test("half an identity, or no questions and no call, is refused", async () => {
  const agent = fakeAgent({ features: NAMES });
  assert.equal((await deliverAnswer(agent, { answers, callId: "c1" }, WS)).ok, false);
  assert.equal((await deliverAnswer(agent, { answers }, WS)).ok, false);
  assert.equal(agent.sent.length, 0);
});

test("a named call whose box doesn't answer its health check is a retryable 502, not a capability refusal", async () => {
  const agent = fakeAgent({ features: NAMES });
  agent.health = async () => {
    throw new TypeError("fetch failed");
  };
  const out = await deliverAnswer(agent, { answers, callId: "c1", launchEpoch: "e1", answerOperationId: "op" }, WS);
  assert.deepEqual(out, { ok: false, status: 502, error: UNREACHABLE_MESSAGE });
  assert.equal(agent.sent.length, 0);
  // A card's answer isn't sent by its text instead, which could reach another call: try again.
  assert.deepEqual(await deliverAnswer(agent, { questions, answers, toolUseId: "toolu_1" }, WS), { ok: false, status: 502, error: UNREACHABLE_MESSAGE });
  assert.equal(agent.sent.length, 0);
  // Naming no call at all (an older client): the text-matched answer, as before.
  assert.deepEqual(await deliverAnswer(agent, { questions, answers }, WS), { ok: true, replayed: false, named: false });
});
