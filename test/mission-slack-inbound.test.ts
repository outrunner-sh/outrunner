/**
 * Slack's events for a Mission saved before Slack is answered
 * (lib/missions/slack-inbound.ts), with the events endpoint's own logic
 * (acceptInbound) and a store that behaves as mission_slack_inbound's lease
 * functions do (test/mission-slack-sql.test.ts runs those for real): a
 * crash after the answer loses nothing; a retry of the event is one row; a
 * database that's down is a retry for Slack; the tick picks up what was
 * never processed, once its lease has run out.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptInbound, type InboundDeps, MAX_INBOUND_ATTEMPTS, missionEligible, processInbound } from "@/lib/missions/slack-inbound";
import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import type { AgentMessage } from "@/lib/slack/agent-run";

const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
const owned: MissionThread = { id: "t1", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "1731400000.000100", permalink: null, startedBy: "ana", startedBySlack: "UANA", lastRequestTs: null, muted: false };

function store() {
  let clock = 0;
  const rows = new Map<string, { message: AgentMessage; status: "pending" | "done" | "failed"; attempts: number; leaseUntil: number | null; nextAt: number }>();
  const handled: string[] = [];
  const state = { down: false, handle: "ok" as "ok" | "throw" | "crash" };
  const deps: InboundDeps = {
    binding: async (_team, channel) => {
      if (state.down) throw new Error("connection refused");
      return channel === "C1" ? binding : null;
    },
    thread: async (_team, _channel, ts) => (ts === owned.threadTs ? owned : null),
    save: async (eventId, message) => {
      if (state.down) throw new Error("connection refused");
      if (rows.has(eventId)) return false;
      rows.set(eventId, { message, status: "pending", attempts: 0, leaseUntil: null, nextAt: 0 });
      return true;
    },
    claim: async (eventId) => {
      const row = rows.get(eventId);
      if (!row || row.status !== "pending" || row.nextAt > clock || (row.leaseUntil !== null && row.leaseUntil > clock)) return null;
      row.attempts++;
      row.leaseUntil = clock + 120;
      return { message: row.message, attempt: row.attempts };
    },
    handle: async (message, options) => {
      if (state.handle === "crash") throw Object.assign(new Error("process died"), { crash: true });
      if (state.handle === "throw" && !options.final) throw new Error("database blip");
      handled.push(`${message.eventId}${options.final ? " (final)" : ""}`);
    },
    complete: async (eventId, attempt) => {
      const row = rows.get(eventId)!;
      if (row.attempts === attempt) Object.assign(row, { status: "done", leaseUntil: null });
    },
    fail: async (eventId, attempt) => {
      const row = rows.get(eventId)!;
      if (row.attempts !== attempt) return;
      row.leaseUntil = null;
      row.nextAt = clock + 15;
      if (row.attempts >= MAX_INBOUND_ATTEMPTS) row.status = "failed";
    },
  };
  return { deps, rows, handled, state, advance: (s: number) => (clock += s) };
}

function msg(patch: Partial<AgentMessage> = {}): AgentMessage {
  return { teamId: "T1", channel: "C1", user: "UANA", text: "<@UBOT> fix it", ts: "1731400000.000100", mention: true, eventId: "Ev1", ...patch };
}

test("which events are a Mission's: mentions in a bound channel, replies in its threads", async () => {
  const { deps } = store();
  assert.equal(await missionEligible(msg(), deps), true);
  assert.equal(await missionEligible(msg({ mention: false, threadTs: owned.threadTs }), deps), true);
  assert.equal(await missionEligible(msg({ mention: false, threadTs: "1731400099.000100" }), deps), false, "another thread");
  assert.equal(await missionEligible(msg({ mention: false, topLevel: true }), deps), false, "chatter");
  assert.equal(await missionEligible(msg({ channel: "C2" }), deps), false, "no Mission there");
  assert.equal(await missionEligible(msg({ channel: "D1", channelType: "im" }), deps), false);
});

test("saved before the answer: a retry of the event is the same row, acknowledged", async () => {
  const { deps, rows } = store();
  assert.equal(await acceptInbound("Ev1", msg(), deps), "saved");
  assert.equal(await acceptInbound("Ev1", msg(), deps), "duplicate");
  assert.equal(await acceptInbound("Ev2", msg({ channel: "C2", eventId: "Ev2" }), deps), "not_mission");
  assert.equal(rows.size, 1);
});

test("a database that's down is thrown, so the endpoint answers for Slack to retry", async () => {
  const { deps, state, rows } = store();
  state.down = true;
  await assert.rejects(acceptInbound("Ev1", msg(), deps), /connection refused/);
  state.down = false;
  // Slack's retry: saved now, once.
  assert.equal(await acceptInbound("Ev1", msg(), deps), "saved");
  assert.equal(rows.size, 1);
});

test("a crash after the answer loses nothing: the tick processes it once the lease runs out", async () => {
  const { deps, handled, state, advance, rows } = store();
  await acceptInbound("Ev1", msg(), deps);
  // The processor right after the answer takes it, then the process dies
  // (nothing recorded: the throw stands in for a process that's gone).
  state.handle = "crash";
  const claim = await deps.claim("Ev1");
  assert.ok(claim);
  state.handle = "ok";
  // A second processor meanwhile: the lease holds it off.
  assert.equal(await processInbound("Ev1", deps), "busy");
  advance(121);
  assert.equal(await processInbound("Ev1", deps), "done");
  assert.deepEqual(handled, ["Ev1"]);
  assert.equal(rows.get("Ev1")?.status, "done");
  // Done is done: a later tick or a retry of the event does nothing.
  assert.equal(await processInbound("Ev1", deps), "busy");
  assert.equal(await acceptInbound("Ev1", msg(), deps), "duplicate");
  assert.deepEqual(handled, ["Ev1"]);
});

test("a failure is tried again with backoff; the last try says sorry and is done", async () => {
  const { deps, handled, state, advance, rows } = store();
  await acceptInbound("Ev1", msg(), deps);
  state.handle = "throw";
  for (let i = 1; i < MAX_INBOUND_ATTEMPTS; i++) {
    assert.equal(await processInbound("Ev1", deps), "retry", `try ${i}`);
    assert.equal(await processInbound("Ev1", deps), "busy", "backing off");
    advance(16);
  }
  assert.equal(await processInbound("Ev1", deps), "done");
  assert.deepEqual(handled, ["Ev1 (final)"]);
  assert.equal(rows.get("Ev1")?.attempts, MAX_INBOUND_ATTEMPTS);
});
