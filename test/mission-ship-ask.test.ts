/**
 * A Ship's ask_user question answered from Slack (lib/missions/ship-ask.ts):
 * one card a call in the thread of the request that started the Ship, laid
 * out as "Working on", the question, a button an option and "Other"; a click
 * answers that exact call through #421's path (deliverAnswer); the gate of a
 * request; stale cards (answered in the app, the Ship ended, a rebind, off
 * call) answer nothing and say "No longer waiting"; a muted thread gets no
 * card; the watch posts the card and closes it once the call is over. The
 * table's SQL runs on a real Postgres with MISSIONS_PG.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";

import {
  answerShipAsk,
  postShipAsk,
  settleShipAsks,
  SHIP_ASK_NO_ACCESS,
  SHIP_ASK_OFF_CALL,
  SHIP_ASK_STALE,
  shipAnswerOperation,
  shipAskKey,
  type ShipAskClickDeps,
  type ShipAskPostDeps,
} from "@/lib/missions/ship-ask";
import { checkRunnerWatch, type WatchDeps, type WatchRow } from "@/lib/missions/watch";
import { deliverPost, type ClaimedPost, type OutboxPostDeps, type QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionThread, ShipAsk, ShipLedger } from "@/lib/missions/slack-store";
import { SHIP_ASK_ACTION, SHIP_ASK_OPEN, SHIP_CARD_MOVED_ON } from "@/lib/missions/slack-text";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_ASK_CALL_IDENTITY, AnswerRequest, type AnswerRequest as AnswerRequestType, type PendingQuestionSummary } from "@/lib/runtime/agent-protocol";
import { deliverAnswer } from "@/lib/runtime/answer-question";
import { QUESTION_EXPIRED_MESSAGE } from "@/lib/runtime/pending-question";
import type { Workspace } from "@/lib/runtime/types";

const thread: MissionThread = {
  id: "t1",
  missionId: "m1",
  teamId: "T1",
  channelId: "C1",
  threadTs: "1731400000.000100",
  permalink: null,
  startedBy: "ana",
  startedBySlack: "UANA",
  lastRequestTs: "1731400000.000100",
  muted: false,
};
const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
const ship = (over: Partial<Workspace> = {}) =>
  ({ id: "r1", parentMissionId: "m1", ownerId: "owner", status: "ready", title: "Fix the login redirect", branch: "runtime/login", ...over }) as Workspace;
const questions = [{ question: "Which environment should I deploy the fix to?", options: ["staging", { label: "production", description: "live" }] }];
const call = (over: Partial<PendingQuestionSummary> = {}): PendingQuestionSummary => ({ callId: "c1", launchEpoch: "e1", workspaceId: "r1", chat: "main", toolUseId: "toolu_1", questions, ...over });

/** The database and Slack as the deps see them, in memory: asks behave as
 *  mission_ship_asks' conditional updates do. */
function world(opts: { binding?: MissionChannel | null; muted?: boolean; ledger?: Partial<ShipLedger> | null; waiting?: PendingQuestionSummary[] | null } = {}) {
  const asks = new Map<string, ShipAsk>();
  const posts = new Map<string, QueuedPost>();
  let agentAsked = 0;
  let waiting = opts.waiting === undefined ? [call()] : opts.waiting;
  const ledger: ShipLedger | null =
    opts.ledger === null ? null : { requestKey: "Ev1", requestedBy: "ana", bindingRevision: "rev1", thread: { ...thread, muted: opts.muted ?? false }, ...opts.ledger };
  const post: ShipAskPostDeps = {
    ledger: async (id) => (id === "r1" ? ledger : null),
    binding: async () => (opts.binding === undefined ? binding : opts.binding),
    existing: async (runnerId, toolUseId) => [...asks.values()].find((a) => a.runnerId === runnerId && a.toolUseId === toolUseId) ?? null,
    queued: async (opKey) => posts.has(opKey),
    pending: async () => {
      agentAsked++;
      return waiting;
    },
    save: async (input) => {
      const found = [...asks.values()].find((a) => a.opKey === input.opKey);
      if (found) return found;
      const ask: ShipAsk = { ...input, id: randomUUID(), messageTs: null, answeredAt: null, closedAt: null };
      asks.set(ask.id, ask);
      return ask;
    },
    queue: async (p) => {
      if (posts.has(p.opKey)) return "already_pending";
      posts.set(p.opKey, p);
      // The queue posted it: its message recorded (shipAskPosted).
      const id = (p.payload as { shipAskId: string }).shipAskId;
      asks.set(id, { ...asks.get(id)!, messageTs: `ts-${posts.size}` });
      return "queued";
    },
    shipUrl: (id) => `https://outrunner.example.com/workspaces/${id}`,
  };
  return {
    asks,
    posts,
    post,
    agentAsked: () => agentAsked,
    setWaiting: (w: PendingQuestionSummary[] | null) => {
      waiting = w;
    },
  };
}

/** The click's deps over a world, with a fake agent behind #421's real
 *  deliverAnswer; records what's said and every answer the agent got. */
function clicks(w: ReturnType<typeof world>, opts: { binding?: MissionChannel | null; runner?: Partial<Workspace> | null; agent?: (req: AnswerRequestType, n: number) => Promise<unknown> } = {}) {
  const said: string[] = [];
  const edits: { ts: string; blocks: Record<string, unknown>[] }[] = [];
  const sent: AnswerRequestType[] = [];
  const deps: ShipAskClickDeps = {
    ask: async (id) => w.asks.get(id) ?? null,
    thread: async () => thread,
    binding: async () => (opts.binding === undefined ? binding : opts.binding),
    mission: async () => ({ id: "m1", kind: "mission", status: "ready" }) as Workspace,
    runner: async () => (opts.runner === null ? null : ship(opts.runner)),
    linked: async (u) => (u === "UANA" ? { userId: "ana", orgId: "o1" } : u === "UBO" ? { userId: "bo", orgId: "o1" } : u === "UNORA" ? { userId: "nora", orgId: "o2" } : null),
    level: async (userId) => (userId === "ana" || userId === "nora" ? "read" : null),
    claim: async (id, answer) => {
      const ask = w.asks.get(id)!;
      if (ask.answeredAt || ask.closedAt) return false;
      w.asks.set(id, { ...ask, answeredAt: "now", answeredBy: answer.slackUserId } as ShipAsk);
      return true;
    },
    release: async (id, by) => {
      const ask = w.asks.get(id) as ShipAsk & { answeredBy?: string };
      if (ask.answeredBy === by && !ask.closedAt) w.asks.set(id, { ...ask, answeredAt: null, answeredBy: undefined } as ShipAsk);
    },
    close: async (id, claimedBy) => {
      const ask = w.asks.get(id) as ShipAsk & { answeredBy?: string };
      if (ask.closedAt || (claimedBy ? ask.answeredBy !== claimedBy : ask.answeredAt)) return false;
      w.asks.set(id, { ...ask, closedAt: "now", answeredAt: null });
      return true;
    },
    answer: (_runner, ask, label) =>
      deliverAnswer(
        {
          health: async () => ({ status: "ok", features: [AGENT_FEATURE_ASK_CALL_IDENTITY] }),
          pendingQuestions: async () => [],
          answer: async (req) => {
            sent.push(AnswerRequest.parse(req));
            return (opts.agent ? await opts.agent(req, sent.length) : { result: "answered" }) as never;
          },
        },
        { questions: ask.questions, answers: [{ selected: [label], other: "" }], callId: ask.callId, launchEpoch: ask.launchEpoch, answerOperationId: shipAnswerOperation(ask.id) },
        { workspaceId: "r1" },
      ),
    name: async () => "Ana",
    edit: async (_team, _channel, ts, _text, blocks) => {
      edits.push({ ts, blocks });
    },
    tell: async (_c, _t, text) => {
      said.push(text);
    },
    askToConnect: async () => {
      said.push("connect");
    },
  };
  return { deps, said, edits, sent };
}

const click = (user: string, value: string) => ({ teamId: "T1", user, value, channel: "C1" });
const expired = () => Promise.reject(new AgentRequestError(409, { code: "CONFLICT", message: QUESTION_EXPIRED_MESSAGE }));

async function posted(w = world()) {
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "queued");
  return { w, ask: [...w.asks.values()][0] };
}

test("a Ship's question is one card a call, in its request's thread, laid out Working on / question / options / Other", async () => {
  const w = world();
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "queued");
  // The watch looks again (and again): the card is made, the box isn't asked.
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "exists");
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "exists");
  assert.equal(w.agentAsked(), 1);
  assert.equal(w.posts.size, 1);
  const [card] = w.posts.values();
  const [ask] = w.asks.values();
  assert.equal(card.opKey, shipAskKey("r1", { callId: "c1", launchEpoch: "e1" }));
  assert.equal(ask.opKey, card.opKey);
  assert.deepEqual([ask.callId, ask.launchEpoch, ask.toolUseId], ["c1", "e1", "toolu_1"]);
  assert.deepEqual([card.teamId, card.channelId, card.threadTs, card.bindingRevision, card.requester, card.kind], ["T1", "C1", thread.threadTs, "rev1", "ana", "ask"]);
  const blocks = (card.payload as { blocks: Record<string, unknown>[] }).blocks as { type: string; elements?: Record<string, unknown>[]; text?: { text: string } }[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["context", "section", "actions"],
  );
  assert.match(JSON.stringify(blocks[0]), /Working on: \*Fix the login redirect\*/);
  assert.equal(blocks[1].text?.text, "Which environment should I deploy the fix to?");
  const buttons = blocks[2].elements as { action_id: string; text: { text: string }; value?: string; url?: string }[];
  assert.deepEqual(
    buttons.map((b) => b.text.text),
    ["staging", "production", "Other"],
  );
  assert.deepEqual(
    buttons.map((b) => b.action_id),
    [`${SHIP_ASK_ACTION}:0`, `${SHIP_ASK_ACTION}:1`, SHIP_ASK_OPEN],
  );
  assert.deepEqual([buttons[0].value, buttons[1].value], [`${ask.id}:0`, `${ask.id}:1`]);
  // "Other" links to the Ship; it takes no text in Slack.
  assert.equal(buttons[2].url, "https://outrunner.example.com/workspaces/r1");
  assert.equal(buttons[2].value, undefined);
  // The same call's key is one key; a new call, or the same call id asked of
  // a restarted agent (a new launch), is a card of its own.
  assert.equal(shipAskKey("r1", { callId: "c1", launchEpoch: "e1" }), card.opKey);
  w.setWaiting([call({ launchEpoch: "e2", toolUseId: "toolu_2" })]);
  assert.equal(await postShipAsk(ship(), "toolu_2", w.post), "queued");
  assert.equal(w.posts.size, 2);
});

test("the same call seen under a new transcript id, or queued twice, is still one post", async () => {
  const w = world();
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "queued");
  // The agent hasn't tied the call to the transcript yet, and the watch read
  // another id: the key is the call's, so nothing more is posted.
  w.setWaiting([call({ toolUseId: undefined })]);
  assert.equal(await postShipAsk(ship(), "toolu_other", w.post), "exists");
  assert.equal(w.posts.size, 1);
  // Made but its post never queued (a crash between the two): queued now, once.
  const lost = world();
  await lost.post.save({ ...[...w.asks.values()][0], id: undefined } as never);
  assert.equal(await postShipAsk(ship(), "toolu_1", lost.post), "queued");
  assert.equal(await postShipAsk(ship(), "toolu_1", lost.post), "exists");
  assert.equal(lost.posts.size, 1);
  assert.equal(lost.agentAsked(), 0);
});

test("no card for a muted thread, a Ship with no Slack thread, a binding that's over, or an agent that can't name calls", async () => {
  const muted = world({ muted: true });
  assert.equal(await postShipAsk(ship(), "toolu_1", muted.post), "muted");
  assert.equal(muted.agentAsked(), 0);
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ ledger: null }).post), "not_slack");
  assert.equal(await postShipAsk(ship({ parentMissionId: null }), "toolu_1", world().post), "not_slack");
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ binding: null }).post), "off_call");
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ binding: { ...binding, revision: "rev2" } }).post), "off_call");
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ binding: { ...binding, channelId: "C9" } }).post), "off_call");
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ waiting: null }).post), "cant_name_calls");
  // Waiting on another verified call than the watch saw: not this one.
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ waiting: [call({ toolUseId: "toolu_9" })] }).post), "not_pending");
  assert.equal(await postShipAsk(ship(), "toolu_1", world({ waiting: [] }).post), "not_pending");
});

test("several questions, or several picks, get a card that links to the Ship instead of buttons", async () => {
  const w = world({ waiting: [call({ questions: [{ question: "Which?", options: ["a", "b"], multiSelect: true }] })] });
  assert.equal(await postShipAsk(ship(), "toolu_1", w.post), "queued");
  const [ask] = w.asks.values();
  assert.deepEqual(ask.options, []);
  const blocks = JSON.stringify((([...w.posts.values()][0].payload as { blocks: unknown }).blocks));
  assert.equal(blocks.includes(`"${SHIP_ASK_ACTION}:0"`), false);
  assert.match(blocks, /Answer in Outrunner/);
});

test("a click answers that exact call through #421's path, once, and the card says who picked what", async () => {
  const { w, ask } = await posted();
  const c = clicks(w);
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:1`), c.deps), "answered");
  assert.equal(c.sent.length, 1);
  assert.deepEqual(
    { callId: c.sent[0].callId, launchEpoch: c.sent[0].launchEpoch, answerOperationId: c.sent[0].answerOperationId, answers: c.sent[0].answers },
    { callId: "c1", launchEpoch: "e1", answerOperationId: shipAnswerOperation(ask.id), answers: [{ selected: ["production"], other: "" }] },
  );
  assert.deepEqual(c.sent[0].questions, questions);
  // The card: no buttons, the pick and who.
  assert.equal(c.edits.length, 1);
  assert.equal(c.edits[0].ts, ask.messageTs);
  const card = JSON.stringify(c.edits[0].blocks);
  assert.equal(card.includes('"button"'), false);
  assert.match(card, /Working on: \*Fix the login redirect\*/);
  assert.match(card, /\*production\*, picked by Ana/);
  // A second click, the same pick or another: nothing more reaches the agent.
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "stale");
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:1`), c.deps), "stale");
  assert.equal(c.sent.length, 1);
  assert.deepEqual(c.said, [SHIP_ASK_STALE, SHIP_ASK_STALE]);
  // Junk, an option that isn't there, another channel's click: ignored.
  assert.equal(await answerShipAsk(click("UANA", "junk"), c.deps), "ignored");
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:7`), c.deps), "ignored");
  assert.equal(await answerShipAsk({ ...click("UANA", `${ask.id}:0`), channel: "C2" }, c.deps), "ignored");
});

test("an answer lost on the way is sent again under the same operation, and lands once", async () => {
  const { w, ask } = await posted();
  const c = clicks(w, { agent: async (_req, n) => (n === 1 ? Promise.reject(new Error("socket hang up")) : { result: "answered", replayed: true }) });
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "answered");
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[0].answerOperationId, c.sent[1].answerOperationId);
});

test("unlinked people get the connect prompt; people who can't read the project, or of another org, are told no", async () => {
  const { w, ask } = await posted();
  const c = clicks(w);
  assert.equal(await answerShipAsk(click("UUNA", `${ask.id}:0`), c.deps), "refused");
  assert.equal(await answerShipAsk(click("UBO", `${ask.id}:0`), c.deps), "refused");
  assert.equal(await answerShipAsk(click("UNORA", `${ask.id}:0`), c.deps), "refused");
  assert.deepEqual(c.said, ["connect", SHIP_ASK_NO_ACCESS, SHIP_ASK_NO_ACCESS]);
  assert.equal(c.sent.length, 0);
  assert.equal(c.edits.length, 0);
  assert.equal(w.asks.get(ask.id)!.answeredAt, null);
});

test("stale: answered in the app, the Ship ended, a rebind or off call: No longer waiting, nothing answered", async () => {
  // Answered in Outrunner first: the agent says the call is over; the card closes.
  {
    const { w, ask } = await posted();
    const c = clicks(w, { agent: expired });
    assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "stale");
    assert.deepEqual(c.said, [SHIP_ASK_STALE]);
    assert.ok(w.asks.get(ask.id)!.closedAt);
    assert.equal(w.asks.get(ask.id)!.answeredAt, null);
    assert.match(JSON.stringify(c.edits[0].blocks), new RegExp(SHIP_CARD_MOVED_ON));
    // Clicked again: refused before the agent.
    assert.equal(await answerShipAsk(click("UANA", `${ask.id}:1`), c.deps), "stale");
    assert.equal(c.sent.length, 1);
  }
  // The Ship ended (archived, failed, asleep): never sent; the card closes.
  for (const status of ["archived", "failed", "suspended", "destroyed"] as const) {
    const { w, ask } = await posted();
    const c = clicks(w, { runner: { status } });
    assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "stale");
    assert.deepEqual(c.said, [SHIP_ASK_STALE]);
    assert.equal(c.sent.length, 0);
    assert.ok(w.asks.get(ask.id)!.closedAt);
  }
  {
    const { w, ask } = await posted();
    const c = clicks(w, { runner: null });
    assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "stale");
    assert.equal(c.sent.length, 0);
  }
  // Put on call again (a new revision), or off call, or on call elsewhere.
  for (const b of [{ ...binding, revision: "rev2" }, null, { ...binding, channelId: "C9" }]) {
    const { w, ask } = await posted();
    const c = clicks(w, { binding: b });
    assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), c.deps), "stale");
    assert.deepEqual(c.said, [SHIP_ASK_OFF_CALL]);
    assert.equal(c.sent.length, 0);
    assert.equal(w.asks.get(ask.id)!.answeredAt, null);
  }
  // Every stale reply says so.
  for (const text of [SHIP_ASK_STALE, SHIP_ASK_OFF_CALL]) assert.match(text, /^No longer waiting/);
});

test("a box that doesn't answer gives the claim back, so the next click can answer", async () => {
  const { w, ask } = await posted();
  const down = clicks(w, { agent: async () => Promise.reject(new AgentRequestError(400, { code: "INVALID_REQUEST", message: "bad answer" })) });
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), down.deps), "failed");
  assert.deepEqual(down.said, ["bad answer"]);
  assert.equal(w.asks.get(ask.id)!.answeredAt, null);
  const up = clicks(w);
  assert.equal(await answerShipAsk(click("UANA", `${ask.id}:0`), up.deps), "answered");
});

test("a card whose call is over is closed by the watch; the call still waiting, and a card claimed in Slack, are left", async () => {
  const w = world();
  await postShipAsk(ship(), "toolu_1", w.post);
  w.setWaiting([call({ callId: "c2", toolUseId: "toolu_2" })]);
  await postShipAsk(ship(), "toolu_2", w.post);
  w.setWaiting([call({ callId: "c3", toolUseId: "toolu_3" })]);
  await postShipAsk(ship(), "toolu_3", w.post);
  const [first, second, third] = [...w.asks.values()];
  // The second is mid-answer from Slack.
  w.asks.set(second.id, { ...second, answeredAt: "now" });
  const edits: string[] = [];
  const deps = {
    open: async (runnerId: string) => [...w.asks.values()].filter((a) => a.runnerId === runnerId && !a.answeredAt && !a.closedAt),
    close: async (id: string) => {
      const a = w.asks.get(id)!;
      if (a.answeredAt || a.closedAt) return false;
      w.asks.set(id, { ...a, closedAt: "now" });
      return true;
    },
    thread: async () => thread,
    edit: async (_t: string, _c: string, ts: string, _text: string, blocks: Record<string, unknown>[]) => {
      assert.match(JSON.stringify(blocks), new RegExp(SHIP_CARD_MOVED_ON));
      assert.equal(JSON.stringify(blocks).includes('"button"'), false);
      edits.push(ts);
    },
  };
  // Waiting on the third: the first closes.
  assert.equal(await settleShipAsks("r1", "toolu_3", deps), 1);
  assert.deepEqual(edits, [first.messageTs]);
  // Working again (answered in Outrunner): the third closes too.
  assert.equal(await settleShipAsks("r1", null, deps), 1);
  assert.deepEqual(edits, [first.messageTs, third.messageTs]);
  assert.equal(w.asks.get(second.id)!.closedAt, null);
  // Nothing left: nothing edited again.
  assert.equal(await settleShipAsks("r1", null, deps), 0);
});

test("the watch posts the card while a Ship waits on a question, and closes it once it's working or done", async () => {
  const T0 = Date.parse("2026-11-14T10:00:00Z");
  const calls: string[] = [];
  let look: Awaited<ReturnType<WatchDeps["look"]>> = {
    reachable: true,
    working: false,
    waiting: "question",
    waitingToolId: "toolu_1",
    summary: { lastAssistantMessage: "Which env?", lastActivity: new Date(T0 + 5000).toISOString(), state: "running" },
  };
  let row: WatchRow | null = { workspaceId: "r1", sentAt: new Date(T0).toISOString(), baselineActivity: null, seenWorking: false, quietSince: null, quietActivity: null, lastMessage: null, unreachableSince: null };
  const deps: WatchDeps = {
    session: async () => ship(),
    look: async () => look,
    save: async (r) => {
      row = r;
    },
    close: async () => {
      row = null;
    },
    record: async () => true,
    takeQueued: async () => null,
    returnQueued: async () => undefined,
    sendAndWatch: async () => true,
    now: () => T0 + 60_000,
    shipAsks: {
      waiting: async (_r, id) => void calls.push(`waiting ${id}`),
      settled: async (_r, keep) => void calls.push(`settled ${keep}`),
    },
  };
  assert.equal(await checkRunnerWatch(row!, deps), "needs_attention");
  assert.deepEqual(calls, ["settled toolu_1", "waiting toolu_1"]);
  // Waiting on its plan instead: no card, the question's closed.
  calls.length = 0;
  look = { ...look, waiting: "plan", waitingToolId: "toolu_p" };
  await checkRunnerWatch(row!, deps);
  assert.deepEqual(calls, ["settled null"]);
  // Working again: whatever it asked was answered.
  calls.length = 0;
  look = { ...look, waiting: null, waitingToolId: null, working: true };
  assert.equal(await checkRunnerWatch(row!, deps), "waiting");
  assert.deepEqual(calls, ["settled null"]);
  // Unreachable for a moment: nothing closed on no evidence.
  calls.length = 0;
  look = { reachable: false, working: null, summary: null };
  await checkRunnerWatch(row!, deps);
  assert.deepEqual(calls, []);
  // Archived: closed.
  deps.session = async () => ship({ status: "archived" });
  assert.equal(await checkRunnerWatch(row!, deps), "closed");
  assert.deepEqual(calls, ["settled null"]);
});

test("the queue records a Ship card's message once it's posted", async () => {
  const recorded: string[] = [];
  const post: ClaimedPost = {
    id: "p1",
    opKey: "ship_ask:r1:abc",
    missionId: "m1",
    bindingRevision: "rev1",
    teamId: "T1",
    channelId: "C1",
    threadTs: thread.threadTs,
    kind: "ask",
    payload: { text: "q", blocks: [], shipAskId: "a1" },
    requester: "ana",
    attempt: 1,
    progress: 0,
    postedTs: [],
    inDoubt: false,
  };
  const deps: OutboxPostDeps = {
    binding: async () => binding,
    muted: async () => false,
    mission: async () => ({ id: "m1", kind: "mission", status: "ready" }) as Workspace,
    canRead: async () => true,
    post: async () => "1731400009.000100",
    react: async () => undefined,
    markers: async () => ({ markers: new Map(), complete: true }),
    progressed: async () => undefined,
    askPosted: async () => void recorded.push("mission ask"),
    shipAskPosted: async (id, ts) => void recorded.push(`${id} ${ts}`),
  };
  assert.equal((await deliverPost(post, deps)).status, "sent");
  assert.deepEqual(recorded, ["a1 1731400009.000100"]);
  // Muted since it was queued: dropped, nothing recorded.
  recorded.length = 0;
  assert.equal((await deliverPost(post, { ...deps, muted: async () => true })).status, "dropped");
  assert.deepEqual(recorded, []);
});

// ---------------------------------------------------------------------------
// The table on a real Postgres (MISSIONS_PG)
// ---------------------------------------------------------------------------

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";
let url = "";
const name = `mission_ship_asks_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function psql(sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8" }).trim();
}

function fails(sql: string, pattern: RegExp) {
  assert.throws(
    () => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }),
    (error: { stderr?: string }) => pattern.test(String(error.stderr)),
  );
}

before(() => {
  if (!server) return;
  execFileSync("psql", [server, "-qc", `create database ${name}`]);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "test/sql/missions-stub.sql"]);
  for (const file of readdirSync("supabase/migrations").filter((f) => f >= "20261102200000" && f.includes("mission")).sort()) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`]);
  }
});

after(() => {
  if (server) execFileSync("psql", [server, "-qc", `drop database if exists ${name} with (force)`]);
});

test("mission_ship_asks: one card a key and a call; the first claim only; a closed card can't be claimed", { skip }, () => {
  const owner = "00000000-0000-0000-0000-00000000000a";
  const m = psql(`insert into workspaces (owner_id, kind, status) values ('${owner}', 'mission', 'ready') returning id`);
  const r = psql(`insert into workspaces (owner_id, parent_mission_id, status) values ('${owner}', '${m}', 'ready') returning id`);
  const t = psql(`insert into mission_threads (mission_id, slack_team_id, channel_id, thread_ts) values ('${m}', 'T1', 'C100', '1731400000.000100') returning id`);
  const insert = (opKey: string, callId: string, extra = "") =>
    `insert into mission_ship_asks (mission_id, runner_id, thread_id, binding_revision, op_key, call_id, launch_epoch, title, question, options, questions${extra ? ", tool_use_id" : ""})
     values ('${m}', '${r}', '${t}', gen_random_uuid(), '${opKey}', '${callId}', 'e1', 'Fix', 'Which?', array['a','b'], '[]'::jsonb${extra ? `, '${extra}'` : ""}) on conflict (op_key) do nothing returning id`;
  const id = psql(insert("k1", "c1", "toolu_1"));
  assert.match(id, /^[0-9a-f-]{36}$/);
  // The same key again: nothing new.
  assert.equal(psql(insert("k1", "c1")), "");
  // Another key for the same call: refused.
  fails(insert("k2", "c1"), /mission_ship_asks_runner_id_call_id_launch_epoch_key/);
  fails(insert("k3", "c3").replace("array['a','b']", "array['1','2','3','4','5','6','7','8','9','10','11']"), /mission_ship_asks_options_check/);
  const claim = (by: string) =>
    psql(`update mission_ship_asks set answer = 'a', answered_by_slack = '${by}', answered_at = now() where id = '${id}' and answered_at is null and closed_at is null returning id`);
  assert.equal(claim("UANA"), id);
  assert.equal(claim("UBO"), "");
  // The agent refused it as over: closed under that claim, never claimable.
  assert.equal(psql(`update mission_ship_asks set closed_at = now(), answered_at = null where id = '${id}' and closed_at is null and answered_by_slack = 'UANA' returning id`), id);
  assert.equal(claim("UBO"), "");
  // The open index's question: none left open.
  assert.equal(psql(`select count(*) from mission_ship_asks where runner_id = '${r}' and answered_at is null and closed_at is null`), "0");
  // A Ship deleted takes its cards with it.
  psql(`delete from workspaces where id = '${r}'`);
  assert.equal(psql(`select count(*) from mission_ship_asks`), "0");
});
