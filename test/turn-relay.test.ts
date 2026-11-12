import assert from "node:assert/strict";
import { test } from "node:test";

import { type AwaitedReply, relayTurn, type RelayTarget } from "@/lib/session/turn-relay";
import { QUIET_MS } from "@/lib/session/turn-watch";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const AWAIT_MS = 60 * 60_000;

function harness(over: Partial<RelayTarget> & { awaited?: AwaitedReply | null; message?: string | null; agoMs?: number } = {}) {
  const state = { hash: null as string | null, posted: [] as string[], restored: [] as AwaitedReply[], cleared: 0 };
  const target: RelayTarget = {
    load: async () => (over.awaited === undefined ? { relayedHash: null, relayUntil: new Date(NOW + AWAIT_MS - 120_000).toISOString() } : over.awaited),
    summary: async () => ({ lastAssistantMessage: over.message === undefined ? "Done" : over.message, lastActivity: new Date(NOW - (over.agoMs ?? QUIET_MS + 1)).toISOString() }),
    claim: async (digest) => {
      if (state.hash === digest) return false;
      state.hash = digest;
      return true;
    },
    clear: async () => void (state.cleared += 1),
    restore: async (previous) => void state.restored.push(previous),
    post: async (message) => void state.posted.push(message),
    ...over,
  };
  return { target, state };
}

test("a finished turn's reply is posted, once", async () => {
  const { target, state } = harness();
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), true);
  assert.deepEqual(state.posted, ["Done"]);
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), true);
  assert.deepEqual(state.posted, ["Done"]);
  assert.equal(state.cleared, 1);
});

test("a turn still going keeps waiting, and posts nothing", async () => {
  const { target, state } = harness({ agoMs: 5_000 });
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), false);
  assert.deepEqual(state.posted, []);
});

test("no summary yet keeps waiting", async () => {
  const { target } = harness({ summary: async () => null });
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), false);
});

test("a reply from before the message was sent isn't this turn's", async () => {
  // Sent 30s ago; the last activity is from 60s ago.
  const { target, state } = harness({ awaited: { relayedHash: null, relayUntil: new Date(NOW + AWAIT_MS - 30_000).toISOString() }, agoMs: 60_000 });
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), false);
  assert.deepEqual(state.posted, []);
});

test("nothing awaited is nothing to wait for", async () => {
  const { target, state } = harness({ awaited: null });
  assert.equal(await relayTurn(target, AWAIT_MS, NOW), true);
  assert.deepEqual(state.posted, []);
});

test("a failed post gives the claim back, and says so", async () => {
  const awaited = { relayedHash: "old", relayUntil: new Date(NOW + AWAIT_MS - 120_000).toISOString() };
  const { target, state } = harness({
    awaited,
    post: async () => {
      throw new Error("Linear is down");
    },
  });
  await assert.rejects(relayTurn(target, AWAIT_MS, NOW));
  assert.deepEqual(state.restored, [awaited]);
});
