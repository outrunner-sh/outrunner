import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { forgetOutrunnerModels, outrunnerModels } from "@/lib/desktop/local-runtime";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  forgetOutrunnerModels();
});

function answer(body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as typeof fetch;
}

test("the menu reads the user's keys, dropping any provider this page doesn't know", async () => {
  answer({ outrunner: true, allowance: true, keys: ["zai", "made-up", 7], available: true });
  assert.deepEqual(await outrunnerModels(), {
    outrunner: true,
    allowance: true,
    keys: ["zai"],
    available: true,
    loadout: { models: [], default: null },
  });
});

test("a server from before providers still gives a menu: its OpenRouter key, and its own models", async () => {
  answer({ available: true, ownKey: true, serverModels: false, allowance: false });
  assert.deepEqual(await outrunnerModels(), {
    outrunner: false,
    allowance: false,
    keys: ["openrouter"],
    available: true,
    loadout: { models: [], default: null },
  });
});

test("the menu carries the user's loadout, made sound", async () => {
  answer({
    outrunner: true,
    keys: [],
    available: true,
    loadout: { models: [{ provider: "codex", id: "gpt-6-sol" }, { provider: "nope", id: "x" }], default: { provider: "codex", id: "gpt-6-sol" } },
  });
  assert.deepEqual((await outrunnerModels()).loadout, {
    models: [{ provider: "codex", id: "gpt-6-sol" }],
    default: { provider: "codex", id: "gpt-6-sol" },
  });
});

test("a failed look isn't kept: the next ask goes out again", async () => {
  let asks = 0;
  globalThis.fetch = (async () => {
    asks += 1;
    return asks === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ outrunner: true, keys: [], available: true }));
  }) as typeof fetch;
  assert.equal((await outrunnerModels()).available, false);
  assert.equal((await outrunnerModels()).available, true);
  assert.equal(asks, 2);
  // An answer is kept.
  await outrunnerModels();
  assert.equal(asks, 2);
});

test("an unreachable server isn't kept either", async () => {
  let asks = 0;
  globalThis.fetch = (async () => {
    asks += 1;
    if (asks === 1) throw new TypeError("Load failed");
    return new Response(JSON.stringify({ outrunner: true, keys: [], available: true }));
  }) as typeof fetch;
  assert.equal((await outrunnerModels()).available, false);
  assert.equal((await outrunnerModels()).available, true);
});
