import assert from "node:assert/strict";
import { test } from "node:test";

import { deliverStoredFirstPrompt, firstPromptToKeep, type FirstPromptDeliveryDeps } from "@/lib/session/deliver-first-prompt";
import { gateFirstPrompt, type FirstPromptClaim, type FirstPromptClaimDeps } from "@/lib/session/first-prompt-claim";
import type { StoredFirstPrompt } from "@/lib/runtime/types";

/** The workspace row's first-prompt claim, as claimFirstPrompt, renewFirstPrompt,
 *  markFirstPromptSent and releaseFirstPrompt treat it (as test/first-prompt-
 *  claim.test.ts holds it). `abandon` stands for the claim's time running out,
 *  which lets the next claim of its key take it over. */
function row(held: string | null = null, sent = false) {
  const state = { held, sent, token: held ? "t0" : null as string | null, abandoned: false, tokens: 0 };
  const mine = (key: string, claimedAt: string) => state.held === key && state.token === claimedAt && !state.sent;
  const take = (key: string): FirstPromptClaim => {
    state.held = key;
    state.sent = false;
    state.abandoned = false;
    state.token = `t${++state.tokens}`;
    return { state: "claimed", claimedAt: state.token };
  };
  const deps: FirstPromptClaimDeps = {
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
      if (mine(key, claimedAt)) {
        state.held = null;
        state.token = null;
      }
    },
  };
  return { state, deps };
}

/** What delivering a kept prompt did, in order. `kept` stands in for
 *  workspaces.first_prompt, `box` for the agent's own record of what reached
 *  it, and the claim starts out `held` by another sender or already `sent`,
 *  as the session page's own copy of the prompt leaves it. */
function delivery(kept: StoredFirstPrompt | null, held: string | null = null, sent = false) {
  const claim = row(held, sent);
  const calls: string[] = [];
  const box: string[] = [];
  const deps: FirstPromptDeliveryDeps = {
    read: async () => {
      calls.push("read");
      return kept;
    },
    gate: (key) => gateFirstPrompt(key, claim.deps, "w1").then((gate) => {
      calls.push(`gate:${gate.outcome}`);
      return gate;
    }),
    attach: async (prompt, attachmentIds) => {
      calls.push(`attach:${attachmentIds.join(",")}`);
      return attachmentIds.length > 0 ? `${prompt} [files]` : prompt;
    },
    send: async (prompt) => {
      calls.push("send");
      box.push(prompt);
    },
    clear: async () => void calls.push("clear"),
    watch: async () => void calls.push("watch"),
  };
  return { claim, calls, box, deps };
}

function quietly(run: () => Promise<void>): Promise<void> {
  const original = console.error;
  console.error = () => {};
  return run().finally(() => {
    console.error = original;
  });
}

const PROMPT: StoredFirstPrompt = { prompt: "fix the build", attachmentIds: ["a1", "a2"], key: "k1" };

test("nothing kept is nothing delivered: no claim, no send, nothing cleared", async () => {
  const { calls, deps } = delivery(null);
  await deliverStoredFirstPrompt(deps, "w1");
  assert.deepEqual(calls, ["read"]);
});

test("a kept prompt is delivered once, its files named in it, then cleared and watched", async () => {
  const { calls, box, claim, deps } = delivery(PROMPT);
  await deliverStoredFirstPrompt(deps, "w1");
  assert.deepEqual(box, ["fix the build [files]"]);
  assert.deepEqual(calls, ["read", "gate:send", "attach:a1,a2", "send", "clear", "watch"]);
  assert.ok(claim.state.sent, "marked sent, so a repeat is answered as already");
});

test("a prompt the page is still sending is left to it: neither sent nor cleared", async () => {
  const { calls, box, deps } = delivery(PROMPT, "k1");
  await deliverStoredFirstPrompt(deps, "w1");
  assert.deepEqual(box, []);
  assert.deepEqual(calls, ["read", "gate:sending"]);
});

test("a prompt the page already sent is only cleared, and never sent again", async () => {
  const { calls, box, deps } = delivery(PROMPT, "k1", true);
  await deliverStoredFirstPrompt(deps, "w1");
  assert.deepEqual(box, []);
  assert.deepEqual(calls, ["read", "gate:sent", "clear"]);
});

test("attachments that can't be written release the claim and keep the copy for a retry", async () => {
  const { claim, calls, box, deps } = delivery(PROMPT);
  deps.attach = async () => {
    throw new Error("box down");
  };
  await quietly(() => deliverStoredFirstPrompt(deps, "w1"));
  assert.deepEqual(box, []);
  assert.deepEqual(calls, ["read", "gate:send"]);
  assert.equal(claim.state.held, null, "released, so a retry still sends");
});

test("a send that fails releases the claim and keeps the copy, without clearing or watching", async () => {
  const { claim, calls, deps } = delivery({ ...PROMPT, attachmentIds: [] });
  deps.send = async () => {
    calls.push("send");
    throw new Error("agent unreachable");
  };
  await quietly(() => deliverStoredFirstPrompt(deps, "w1"));
  assert.deepEqual(calls, ["read", "gate:send", "attach:", "send"]);
  assert.equal(claim.state.held, null, "released, so the page's copy or a retry still sends");
});

test("a claim taken over while the files were written leaves the prompt to its new holder", async () => {
  const { calls, box, deps } = delivery(PROMPT);
  // The session page's own copy took the claim over (this delivery's claim
  // counting as abandoned): it sends, and marks and clears after itself.
  deps.gate = async () => ({
    outcome: "send",
    held: async () => false,
    sent: async () => {},
    release: async () => {},
  });
  await deliverStoredFirstPrompt(deps, "w1");
  assert.deepEqual(box, []);
  // The stubbed gate says nothing of its own; the attach before the takeover
  // was all this delivery did.
  assert.deepEqual(calls, ["read", "attach:a1,a2"]);
});

test("a row that can't be read stops quietly, claiming and sending nothing", async () => {
  const claim = row();
  const calls: string[] = [];
  const deps: FirstPromptDeliveryDeps = {
    read: () => Promise.reject(new Error("down")),
    gate: async (key) => {
      calls.push(`gate:${key}`);
      return gateFirstPrompt(key, claim.deps, "w1");
    },
    attach: async (prompt) => {
      calls.push("attach");
      return prompt;
    },
    send: async () => void calls.push("send"),
    clear: async () => void calls.push("clear"),
    watch: async () => void calls.push("watch"),
  };
  await quietly(() => deliverStoredFirstPrompt(deps, "w1"));
  assert.deepEqual(calls, []);
  assert.equal(claim.state.held, null);
});

test("a claim that can't be made sends nothing unguarded: the kept copy waits for the page", async () => {
  const { claim, calls, box, deps } = delivery(PROMPT);
  // Strict, as setup wires the gate: the claim query itself fails, so the
  // delivery stands down rather than send with nothing recorded — a send the
  // page's own clean claim would send again, twice over.
  const down: FirstPromptClaimDeps = {
    ...claim.deps,
    claim: () => Promise.reject(new Error("down")),
  };
  deps.gate = async (key) => {
    calls.push("gate");
    return gateFirstPrompt(key, down, "w1", { strict: true });
  };
  await quietly(() => deliverStoredFirstPrompt(deps, "w1"));
  assert.deepEqual(box, []);
  assert.deepEqual(calls, ["read", "gate"]);
  assert.equal(claim.state.held, null, "nothing was claimed, so nothing to release");
  await quietly(async () => {
    // Unstrict is the page's own send waiting on its answer: it goes unguarded.
    const unguarded = await gateFirstPrompt("k1", down, "w1");
    assert.equal(unguarded.outcome, "send");
  });
});

test("only a first prompt with its key is kept, trimmed, with its files: the rest ride as they did", () => {
  assert.deepEqual(
    firstPromptToKeep({ prompt: "  fix the build \n", promptKey: "k1", attachmentIds: ["a1", 7, "a2"] }),
    { prompt: "fix the build", attachmentIds: ["a1", "a2"], key: "k1" },
  );
  assert.deepEqual(
    firstPromptToKeep({ prompt: "", promptKey: "k1", attachmentIds: ["a1"] }),
    { prompt: "", attachmentIds: ["a1"], key: "k1" },
    "a prompt of files alone is kept too",
  );
  // No key: a client from before the server kept prompts, which carries its own.
  assert.equal(firstPromptToKeep({ prompt: "fix the build" }), null);
  // An unusable key, or a prompt that isn't one: nothing kept.
  assert.equal(firstPromptToKeep({ prompt: "fix the build", promptKey: "has space" }), null);
  assert.equal(firstPromptToKeep({ prompt: "  ", promptKey: "k1", attachmentIds: [] }), null);
  // An attachment that isn't an id is dropped, not the prompt with it.
  assert.deepEqual(firstPromptToKeep({ prompt: "fix the build", promptKey: "k1", attachmentIds: [7] }), {
    prompt: "fix the build",
    attachmentIds: [],
    key: "k1",
  });
});
