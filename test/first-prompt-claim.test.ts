import assert from "node:assert/strict";
import { test } from "node:test";

import {
  abandonedBefore,
  FIRST_PROMPT_SENDING_MS,
  type FirstPromptClaim,
  firstPromptKey,
  gateFirstPrompt,
} from "@/lib/session/first-prompt-claim";

/** The workspace row's first-prompt claim, as claimFirstPrompt, markFirstPromptSent
 *  and releaseFirstPrompt treat it (bar abandoning, which is the database's). */
function row(held: string | null = null, sent = false) {
  const state = { held, sent, releases: 0 };
  return {
    state,
    deps: {
      claim: async (key: string): Promise<FirstPromptClaim> => {
        if (state.held === null) {
          state.held = key;
          state.sent = false;
          return "claimed";
        }
        if (state.held !== key) return "other";
        return state.sent ? "sent" : "sending";
      },
      sent: async (key: string) => {
        if (state.held === key) state.sent = true;
      },
      release: async (key: string) => {
        state.releases += 1;
        if (state.held === key && !state.sent) state.held = null;
      },
    },
  };
}

function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return run().finally(() => {
    console.error = original;
  });
}

test("only a usable key is one: anything else sends as an ordinary message", () => {
  assert.equal(firstPromptKey("0b7e8f4e-5c1a-4b8e-9c0d-1a2b3c4d5e6f"), "0b7e8f4e-5c1a-4b8e-9c0d-1a2b3c4d5e6f");
  for (const value of [undefined, null, 7, "", "has space", "x".repeat(101), ["k"]]) {
    assert.equal(firstPromptKey(value), null, String(value));
  }
});

test("a first prompt sends once per key: a repeat of one that went is answered as sent", async () => {
  const { state, deps } = row();
  const first = await gateFirstPrompt("k1", deps, "w1");
  assert.equal(first.outcome, "send");
  assert.equal(state.held, "k1");
  await first.sent();
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).outcome, "sent");
});

test("a repeat while the first send is still going waits, rather than counting as sent", async () => {
  const { state, deps } = row();
  const first = await gateFirstPrompt("k1", deps, "w1");
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).outcome, "sending");
  // That send fails: the repeat, tried again, sends it.
  await first.release();
  assert.equal(state.held, null);
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).outcome, "send");
});

test("a repeat, or another key, marks and releases nothing it didn't claim", async () => {
  const { state, deps } = row("k1");
  const repeat = await gateFirstPrompt("k1", deps, "w1");
  await repeat.sent();
  await repeat.release();
  const other = await gateFirstPrompt("k2", deps, "w1");
  assert.equal(other.outcome, "send");
  await other.sent();
  await other.release();
  assert.deepEqual(state, { held: "k1", sent: false, releases: 0 });
});

test("no key sends unguarded, and claims nothing", async () => {
  const { state, deps } = row();
  assert.equal((await gateFirstPrompt(null, deps, "w1")).outcome, "send");
  assert.equal(state.held, null);
});

test("a database that can't claim (not updated yet) sends rather than refuses", async () => {
  const failing = () => Promise.reject(new Error("42703"));
  const gate = await quietly(() => gateFirstPrompt("k1", { claim: failing, sent: failing, release: failing }, "w1"));
  assert.equal(gate.outcome, "send");
});

test("marking or releasing that fails is logged, never thrown into the send's answer", async () => {
  const failing = () => Promise.reject(new Error("down"));
  const gate = await gateFirstPrompt("k1", { claim: async () => "claimed", sent: failing, release: failing }, "w1");
  await quietly(() => gate.sent());
  await quietly(() => gate.release());
});

test("a claim is abandoned only well after its send would have timed out", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  assert.equal(abandonedBefore(now), new Date(now.getTime() - FIRST_PROMPT_SENDING_MS).toISOString());
  assert.ok(FIRST_PROMPT_SENDING_MS > 35_000 * 2);
});
