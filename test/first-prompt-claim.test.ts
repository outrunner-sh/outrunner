import assert from "node:assert/strict";
import { test } from "node:test";

import {
  abandonedBefore,
  FIRST_PROMPT_SENDING_MS,
  type FirstPromptClaim,
  firstPromptKey,
  gateFirstPrompt,
} from "@/lib/session/first-prompt-claim";

/** The workspace row's first-prompt claim, as claimFirstPrompt, renewFirstPrompt,
 *  markFirstPromptSent and releaseFirstPrompt treat it. `abandon` stands for
 *  the claim's time running out: the next claim of its key takes it over. */
function row(held: string | null = null, sent = false) {
  const state = { held, sent, token: held ? "t0" : null as string | null, abandoned: false, releases: 0, tokens: 0 };
  const mine = (key: string, claimedAt: string) => state.held === key && state.token === claimedAt && !state.sent;
  const take = (key: string): FirstPromptClaim => {
    state.held = key;
    state.sent = false;
    state.abandoned = false;
    state.token = `t${++state.tokens}`;
    return { state: "claimed", claimedAt: state.token };
  };
  return {
    state,
    abandon: () => void (state.abandoned = true),
    deps: {
      claim: async (key: string): Promise<FirstPromptClaim> => {
        if (state.held === null) return take(key);
        if (state.held !== key) return { state: "other" };
        if (!state.sent && state.abandoned) return take(key);
        return { state: state.sent ? "sent" : "sending" };
      },
      renew: async (key: string, claimedAt: string) => {
        if (!mine(key, claimedAt)) return null;
        state.token = `t${++state.tokens}`;
        return state.token;
      },
      sent: async (key: string, claimedAt: string) => {
        if (mine(key, claimedAt)) state.sent = true;
      },
      release: async (key: string, claimedAt: string) => {
        state.releases += 1;
        if (mine(key, claimedAt)) {
          state.held = null;
          state.token = null;
        }
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
  assert.equal(state.held, "k1");
  assert.equal(state.sent, false);
  assert.equal(state.releases, 0);
});

test("no key sends unguarded, and claims nothing", async () => {
  const { state, deps } = row();
  assert.equal((await gateFirstPrompt(null, deps, "w1")).outcome, "send");
  assert.equal(state.held, null);
});

test("a database that can't claim (not updated yet) sends rather than refuses", async () => {
  const failing = () => Promise.reject(new Error("42703"));
  const gate = await quietly(() =>
    gateFirstPrompt("k1", { claim: failing, renew: failing, sent: failing, release: failing }, "w1"),
  );
  assert.equal(gate.outcome, "send");
});

test("renewing, marking or releasing that fails is logged, never thrown into the send's answer", async () => {
  const failing = () => Promise.reject(new Error("down"));
  const gate = await gateFirstPrompt(
    "k1",
    { claim: async () => ({ state: "claimed", claimedAt: "t1" }), renew: failing, sent: failing, release: failing },
    "w1",
  );
  // Unrenewed, it still holds: a repeat can't take it over before this send times out.
  assert.equal(await quietly(() => gate.held()), true);
  await quietly(() => gate.sent());
  await quietly(() => gate.release());
});

test("a request whose claim was taken over neither sends, marks nor releases the new holder's", async () => {
  const { state, deps, abandon } = row();
  const slow = await gateFirstPrompt("k1", deps, "w1");
  abandon();
  const retry = await gateFirstPrompt("k1", deps, "w1");
  assert.equal(retry.outcome, "send");
  // The slow one's attachments come back: it must leave the send to the retry.
  assert.equal(await slow.held(), false);
  await slow.release();
  assert.equal(state.held, "k1");
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).outcome, "sending");
  await slow.sent();
  assert.equal(state.sent, false);
  // The retry renews as it goes, and its own mark counts.
  assert.equal(await retry.held(), true);
  await retry.sent();
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).outcome, "sent");
});

test("a renewed claim is still its request's to mark sent or release", async () => {
  const { state, deps } = row();
  const gate = await gateFirstPrompt("k1", deps, "w1");
  assert.equal(await gate.held(), true);
  await gate.release();
  assert.equal(state.held, null);
});

test("a claim is abandoned only well after its send would have timed out", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  assert.equal(abandonedBefore(now), new Date(now.getTime() - FIRST_PROMPT_SENDING_MS).toISOString());
  assert.ok(FIRST_PROMPT_SENDING_MS > 35_000 * 2);
});
