import assert from "node:assert/strict";
import { test } from "node:test";

import { type FirstPromptClaim, firstPromptKey, gateFirstPrompt } from "@/lib/session/first-prompt-claim";

/** The workspace row's first_prompt_key, as claimFirstPrompt and releaseFirstPrompt treat it. */
function row(held: string | null = null) {
  const state = { held, releases: 0 };
  return {
    state,
    deps: {
      claim: async (key: string): Promise<FirstPromptClaim> => {
        if (state.held === null) {
          state.held = key;
          return "claimed";
        }
        return state.held === key ? "repeat" : "other";
      },
      release: async (key: string) => {
        state.releases += 1;
        if (state.held === key) state.held = null;
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

test("a first prompt sends once per key: a repeat is skipped as sent", async () => {
  const { state, deps } = row();
  const first = await gateFirstPrompt("k1", deps, "w1");
  assert.equal(first.repeat, false);
  assert.equal(state.held, "k1");
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).repeat, true);
});

test("a send that fails lets its key go, so a retry with it sends", async () => {
  const { state, deps } = row();
  const first = await gateFirstPrompt("k1", deps, "w1");
  await first.release();
  assert.equal(state.held, null);
  assert.equal((await gateFirstPrompt("k1", deps, "w1")).repeat, false);
});

test("a repeat, or another key, releases nothing it didn't claim", async () => {
  const { state, deps } = row("k1");
  await (await gateFirstPrompt("k1", deps, "w1")).release();
  const other = await gateFirstPrompt("k2", deps, "w1");
  assert.equal(other.repeat, false);
  await other.release();
  assert.equal(state.held, "k1");
  assert.equal(state.releases, 0);
});

test("no key sends unguarded, and claims nothing", async () => {
  const { state, deps } = row();
  assert.equal((await gateFirstPrompt(null, deps, "w1")).repeat, false);
  assert.equal(state.held, null);
});

test("a database that can't claim (not updated yet) sends rather than refuses", async () => {
  const gate = await quietly(() =>
    gateFirstPrompt("k1", { claim: () => Promise.reject(new Error("42703")), release: async () => {} }, "w1"),
  );
  assert.equal(gate.repeat, false);
});

test("a release that fails is logged, never thrown into the send's own failure", async () => {
  const gate = await gateFirstPrompt(
    "k1",
    { claim: async () => "claimed", release: () => Promise.reject(new Error("down")) },
    "w1",
  );
  await quietly(() => gate.release());
});
