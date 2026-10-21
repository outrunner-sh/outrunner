import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { forgetOutrunnerModels, OUTRUNNER_MODELS, outrunnerModels } from "@/lib/desktop/local-runtime";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // Out of date for the next test, without looking again here.
  OUTRUNNER_MODELS.invalidate();
});

/** Answers every look with `body`; says how many looks there were. */
function answer(body: unknown) {
  const looks = { count: 0 };
  globalThis.fetch = (async () => {
    looks.count += 1;
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return looks;
}

/** A server from before connections, said nothing of: all assumed. */
const ALL_CONNECTED = { claude: { cloud: true, local: true }, codex: { cloud: true, local: true } };

test("the menu reads the user's keys, dropping any provider this page doesn't know", async () => {
  answer({ outrunner: true, allowance: true, keys: ["zai", "made-up", 7], available: true });
  assert.deepEqual(await outrunnerModels(), {
    outrunner: true,
    allowance: true,
    keys: ["zai"],
    available: true,
    loadout: { models: [], default: null },
    agents: ALL_CONNECTED,
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
    agents: ALL_CONNECTED,
  });
});

test("the menu carries where the user's own Claude and Codex are connected", async () => {
  const agents = { claude: { cloud: false, local: false }, codex: { cloud: false, local: "mac-login" } };
  answer({ outrunner: true, keys: [], available: true, agents });
  assert.deepEqual((await outrunnerModels()).agents, agents);
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

test("forgetting the menu looks again at once, so a menu shown next has the new answer", async () => {
  answer({ outrunner: true, keys: [], available: true, agents: { claude: { cloud: false, local: false } } });
  assert.equal((await outrunnerModels()).agents.claude.cloud, false);

  // Claude just connected in Settings → Providers.
  const looks = answer({ outrunner: true, keys: [], available: true, agents: { claude: { cloud: true, local: true } } });
  forgetOutrunnerModels();
  assert.equal(looks.count, 1);
  // A menu mounting meanwhile shares that look rather than starting another.
  assert.equal((await outrunnerModels()).agents.claude.cloud, true);
  assert.equal(looks.count, 1);
});
