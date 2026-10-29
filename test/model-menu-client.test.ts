import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { forgetOutrunnerModels, OUTRUNNER_MODELS, outrunnerModels, workspaceModelMenu } from "@/lib/desktop/local-runtime";

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

/** A server from before connections, said nothing of: none assumed. */
const ALL_CONNECTED = { claude: { cloud: false, local: false }, codex: { cloud: false, local: false } };

test("the menu reads the user's keys, dropping any provider this page doesn't know", async () => {
  answer({ outrunner: true, allowance: true, keys: ["zai", "made-up", 7], available: true });
  assert.deepEqual(await outrunnerModels(), {
    outrunner: true,
    allowance: true,
    keys: ["zai"],
    available: true,
    harnesses: [],
    codexModels: [],
    localMenu: undefined,
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
    harnesses: [],
    codexModels: [],
    localMenu: undefined,
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

test("session menus keep their own workspace scope instead of inheriting the active org menu", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ outrunner: true, allowance: false, keys: url.includes("first") ? ["zai"] : ["deepseek"], harnesses: ["claude"], codexModels: [] });
  }) as typeof fetch;
  const first = await workspaceModelMenu("first").ensure();
  const second = await workspaceModelMenu("second").ensure();
  assert.deepEqual(first.keys, ["zai"]);
  assert.deepEqual(second.keys, ["deepseek"]);
  assert.deepEqual(urls, ["/api/outrunner-models?workspace=first", "/api/outrunner-models?workspace=second"]);
});


test("new-session menus use the selected repository scope independently of workspace menus", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ outrunner: true, allowance: false, keys: [], harnesses: ["codex"], codexModels: [] });
  }) as typeof fetch;
  await workspaceModelMenu(undefined, "repo-first").ensure();
  await workspaceModelMenu(undefined, "repo-second").ensure();
  await workspaceModelMenu(undefined, "repo-first").ensure();
  assert.deepEqual(urls, ["/api/outrunner-models?project=repo-first", "/api/outrunner-models?project=repo-second"]);
});
