/**
 * An event that reaches a Mission while it's mid-turn is folded into that
 * turn, not a turn of its own (docs/missions.md): the delivery is sent at
 * once (lib/missions/outbox.ts), Claude takes it in mid-turn, recording it as
 * a queued_command after the tool result it joined, and the turn goes on to
 * one end. Read as the server reads every session (lib/session/turn-state.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDelivery, type MissionEvent, parseRunnerEvents } from "@/lib/missions/events";
import { deliverMissionEvents, type OutboxDeps } from "@/lib/missions/outbox";
import { activityNews } from "@/lib/notifications/events";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { parseConversation } from "@/lib/runtime/replay/conversation";
import { conversationNodes, conversationTurns, conversationTurnSince } from "@/lib/runtime/conversation-nodes";
import { pendingPlan } from "@/lib/runtime/pending-plan";
import type { Workspace } from "@/lib/runtime/types";
import { foldEvents, IDLE, type TurnState } from "@/lib/session/turn-state";

const at = (s: number) => `2026-11-03T10:00:${String(s).padStart(2, "0")}Z`;

const events: MissionEvent[] = [
  {
    id: "e1",
    runnerId: "r1",
    kind: "finished",
    createdAt: at(20),
    payload: { runner: "runner-c", response: "Opened #270." },
  },
];
const delivery = formatDelivery(events);

/** The Mission's conversation, as Claude Code writes it, in the parts a
 *  watch's reads would see one after another. */
function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
const prompt = { type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Spawn runner C, then run sleep 120" } };
const sleeping = {
  type: "assistant",
  uuid: "a1",
  parentUuid: "u1",
  timestamp: at(5),
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 120" } }] },
};
// The delivery, sent while the sleep runs: queued, then absorbed mid-turn.
const absorbed = [
  { type: "queue-operation", operation: "enqueue", timestamp: at(21), content: delivery },
  { type: "queue-operation", operation: "remove", timestamp: at(50), content: delivery, reason: "absorbed_mid_turn" },
  {
    type: "user",
    uuid: "r1",
    parentUuid: "a1",
    timestamp: at(50),
    message: { role: "user", content: [{ tool_use_id: "tu1", type: "tool_result", content: "", is_error: false }] },
  },
  {
    type: "attachment",
    uuid: "q1",
    parentUuid: "r1",
    timestamp: at(50),
    attachment: { type: "queued_command", prompt: delivery, commandMode: "prompt", origin: { kind: "human" }, humanTurn: true },
  },
];
const answer = {
  type: "assistant",
  uuid: "a2",
  parentUuid: "q1",
  timestamp: at(55),
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Runner C opened #270; waiting on its checks." }] },
};

/** Read in parts, as the watch does: each read folds what's new. */
function reads(parts: object[][]): TurnState[] {
  const states: TurnState[] = [];
  let state = IDLE;
  let seen = 0;
  const all: object[] = [];
  for (const part of parts) {
    all.push(...part);
    const parsed: AgentEvent[] = parseConversation(jsonl(all));
    state = foldEvents(state, parsed.slice(seen));
    seen = parsed.length;
    states.push(state);
  }
  return states;
}

test("a delivery while the Mission works is folded into its turn: one turn, one end", () => {
  const states = reads([[prompt], [sleeping], absorbed, [answer]]);
  // Mid-turn through the delivery: no end between it and the reply.
  assert.deepEqual(
    states.map((s) => s.turn),
    ["working", "working", "working", "idle"],
  );
  assert.equal(states[3].repliedAt, at(55));
  // As the watch tells news read by read: the turn ends once.
  const ends = states.slice(1).flatMap((after, i) =>
    activityNews({ before: states[i], after }, { userId: "u", workspaceId: "m1", title: "Mission" }, Date.parse(at(56))),
  );
  assert.deepEqual(
    ends.map((n) => n.kind),
    ["turn_done"],
  );
  // And the Mission's chat shows the delivery as the cards it is.
  const taken = parseConversation(jsonl([prompt, sleeping, ...absorbed])).filter((e) => e.t === "message" && e.role === "user");
  const text = taken.flatMap((e) => (e.t === "message" ? e.content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [])).join("\n");
  assert.equal(parseRunnerEvents(text).events[0].runner, "runner-c");
  const running = conversationNodes(parseConversation(jsonl([prompt, sleeping, ...absorbed])), { working: true });
  assert.equal(running.filter((n) => n.kind === "worked").length, 0, "the delivery doesn't finish a turn still running");
  assert.equal(conversationTurnSince(running), at(1), "the working clock keeps the original prompt's time");
  assert.equal(conversationTurns(running).length, 1, "the delivery adds no tick to the turn rail");
  const news = running.find((n) => n.kind === "prompt" && n.text.includes("<runner_event"));
  assert.equal(news?.kind === "prompt" && news.continuation, true);
  const finished = conversationNodes(parseConversation(jsonl([prompt, sleeping, ...absorbed, answer])));
  assert.deepEqual(finished.filter((n) => n.kind === "worked").map((n) => n.ms), [54_000]);
});

test("the same delivery to a Mission at rest starts a turn of its own", () => {
  const firstReply = {
    type: "assistant",
    uuid: "a0",
    parentUuid: "u1",
    timestamp: at(10),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Spawned runner C." }] },
  };
  const delivered = { type: "user", uuid: "d1", parentUuid: "a0", timestamp: at(20), message: { role: "user", content: delivery } };
  const states = reads([[prompt], [firstReply], [delivered], [{ ...answer, parentUuid: "d1" }]]);
  assert.deepEqual(
    states.map((s) => s.turn),
    ["working", "idle", "working", "idle"],
  );
  const running = conversationNodes(parseConversation(jsonl([prompt, firstReply, delivered])), { working: true });
  assert.equal(conversationTurnSince(running), at(20), "idle delivery starts its own clock");
  assert.equal(conversationTurns(running).length, 2);
  const finished = conversationNodes(parseConversation(jsonl([prompt, firstReply, delivered, { ...answer, parentUuid: "d1" }])));
  assert.deepEqual(finished.filter((n) => n.kind === "worked").map((n) => n.ms), [9_000, 35_000]);
});

test("news absorbed into a plan turn keeps its final words a plan with approval actions", () => {
  const parsed = parseConversation(jsonl([prompt, sleeping, ...absorbed, answer]));
  const events = parsed.map((e): AgentEvent => e.t === "message" && e.uuid === "u1" ? { ...e, mode: "plan" } : e);
  const nodes = conversationNodes(events, { plansInProse: true });
  assert.equal(nodes.find((n) => n.kind === "plan")?.id, "a2");
  assert.deepEqual(pendingPlan(events, { plansInProse: true }), {
    id: "a2", plan: "Runner C opened #270; waiting on its checks.", dismiss: false,
  });
  assert.deepEqual(nodes.filter((n) => n.kind === "worked").map((n) => n.ms), [54_000]);
});

test("news after a stop starts a turn, while malformed runner markup is an ordinary prompt", () => {
  const stop = { type: "user", uuid: "stop", timestamp: at(10), message: { role: "user", content: "[Request interrupted by user]" } };
  const delivered = { type: "user", uuid: "d1", timestamp: at(20), message: { role: "user", content: delivery } };
  const stopped = conversationNodes(parseConversation(jsonl([prompt, sleeping, stop, delivered])), { working: true });
  assert.equal(conversationTurnSince(stopped), at(20));
  assert.equal(conversationTurns(stopped).length, 2);
  const malformed = { ...delivered, message: { ...delivered.message, content: delivery.replace('kind="finished"', 'kind="unknown"') } };
  const nodes = conversationNodes(parseConversation(jsonl([prompt, sleeping, malformed])), { working: true });
  assert.equal(conversationTurnSince(nodes), at(20));
  assert.equal(conversationTurns(nodes).length, 2);
});

test("the outbox sends to a Mission mid-turn at once, not after its turn", async () => {
  const sent: string[] = [];
  const deps: OutboxDeps = {
    claim: async () => ({ deliveryId: "d1", attempt: 1 }),
    eventsOf: async () => events,
    // Mid-turn: ready, with its agent at work. Nothing holds the send.
    session: async () => ({ id: "m1", kind: "mission", status: "ready" }) as Workspace,
    send: async (_m, text, key) => {
      sent.push(`${key}:${parseRunnerEvents(text).events.length}`);
    },
    complete: async () => undefined,
    fail: async () => undefined,
  };
  assert.equal(await deliverMissionEvents("m1", deps), "delivered");
  assert.deepEqual(sent, ["d1:1"]);
});
