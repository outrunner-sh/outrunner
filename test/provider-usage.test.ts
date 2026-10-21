import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { KEY_PROVIDER_IDS, type KeyProviderId } from "@/lib/providers/registry";
import { readProviderUsage, USAGE_READERS, usageCards } from "@/lib/providers/usage";

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

type Seen = { url: string; init: RequestInit };
function answer(response: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return Promise.resolve(response());
  }) as typeof fetch;
  return seen;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
/** Unexpected failures are logged; keep the test output to the tests. */
const quiet = () => (console.error = () => {});

const KEY = "sk-0123456789abcdef0123456789abcdef";

test("an OpenRouter key's spend is read on its own authority, in USD by period", async () => {
  const seen = answer(
    json({
      data: {
        usage: 25.5,
        usage_daily: 1.25,
        usage_weekly: 7,
        usage_monthly: 20,
        limit: 100,
        limit_remaining: 74.5,
        is_management_key: false,
      },
    }),
  );
  assert.deepEqual(await readProviderUsage("openrouter", KEY), {
    ok: true,
    usage: {
      kind: "spend",
      usedUsd: 25.5,
      dailyUsd: 1.25,
      weeklyUsd: 7,
      monthlyUsd: 20,
      limitUsd: 100,
      remainingUsd: 74.5,
    },
  });
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(new Headers(seen[0].init.headers).get("authorization"), `Bearer ${KEY}`);
});

test("an OpenRouter key with no cap, or figures it leaves out, reads as null, not 0", async () => {
  answer(json({ data: { usage: 3, limit: null, limit_remaining: null } }));
  const read = await readProviderUsage("openrouter", KEY);
  assert.ok(read.ok && read.usage.kind === "spend");
  assert.equal(read.usage.usedUsd, 3);
  assert.equal(read.usage.limitUsd, null);
  assert.equal(read.usage.dailyUsd, null);
});

test("DeepSeek's balance is read in each currency it holds, from its decimal strings", async () => {
  const seen = answer(
    json({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "2.50" },
        { currency: "USD", total_balance: "not a number" },
      ],
    }),
  );
  assert.deepEqual(await readProviderUsage("deepseek", KEY), {
    ok: true,
    usage: {
      kind: "balance",
      available: true,
      balances: [
        { currency: "CNY", amount: 110 },
        { currency: "USD", amount: 2.5 },
      ],
    },
  });
  assert.equal(seen[0].url, "https://api.deepseek.com/user/balance");
  assert.ok(seen[0].init.signal instanceof AbortSignal, "no timeout");

  answer(json({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] }));
  const empty = await readProviderUsage("deepseek", KEY);
  assert.ok(empty.ok && empty.usage.kind === "balance" && empty.usage.available === false);
});

test("Moonshot's balance is USD, and none left is not available", async () => {
  const seen = answer(json({ code: 0, data: { available_balance: 49.5, voucher_balance: 46.5, cash_balance: 3 } }));
  assert.deepEqual(await readProviderUsage("moonshot", KEY), {
    ok: true,
    usage: { kind: "balance", available: true, balances: [{ currency: "USD", amount: 49.5 }] },
  });
  assert.equal(seen[0].url, "https://api.moonshot.ai/v1/users/me/balance");

  answer(json({ code: 0, data: { available_balance: -0.2, voucher_balance: 0, cash_balance: -0.2 } }));
  const owed = await readProviderUsage("moonshot", KEY);
  assert.ok(owed.ok && owed.usage.kind === "balance" && owed.usage.available === false);
});

test("a refused key, and a limited one, say so on every provider that reads", async () => {
  for (const provider of ["openrouter", "deepseek", "moonshot"] as const) {
    for (const status of [401, 403]) {
      answer(json({ error: { message: KEY } }, status));
      assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "refused" }, `${provider} ${status}`);
    }
    answer(json({}, 429));
    assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "rate-limited" }, provider);
  }
});

test("a provider that's down, hangs, or answers nonsense is unavailable, and never echoes its body", async () => {
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  for (const provider of ["openrouter", "deepseek", "moonshot"] as const) {
    answer(() => new Response(`upstream echoed ${KEY}`, { status: 503 }));
    assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "unavailable" }, `${provider} 503`);
    answer(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
    assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "unavailable" }, `${provider} timeout`);
  }
  for (const provider of ["deepseek", "moonshot"] as const) {
    answer(json({ unexpected: true }));
    assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "unavailable" }, `${provider} shape`);
  }
  assert.ok(logged.length > 0, "unexpected failures are logged");
  assert.ok(!JSON.stringify(logged.map((args) => args.map(String))).includes(KEY), "the key never reaches the log");
});

test("a provider with no usage API is never asked", async () => {
  quiet();
  const seen = answer(json({}));
  for (const provider of ["anthropic", "zai", "openai"] as const) {
    assert.equal(USAGE_READERS[provider], null);
    assert.deepEqual(await readProviderUsage(provider, KEY), { ok: false, problem: "unavailable" });
  }
  assert.equal(seen.length, 0);
});

test("every provider a key can be saved for has decided its usage reader", () => {
  for (const id of KEY_PROVIDER_IDS) assert.ok(id in USAGE_READERS, id);
});

const NO_KEYS = Object.fromEntries(
  KEY_PROVIDER_IDS.map((id) => [id, { connected: false, hint: null }]),
) as Record<KeyProviderId, { connected: boolean; hint: string | null }>;
const withKeys = (...ids: KeyProviderId[]) => ({
  ...NO_KEYS,
  ...Object.fromEntries(ids.map((id) => [id, { connected: true, hint: `…${id.slice(0, 4)}` }])),
});

test("Usage shows Outrunner's models, each saved key, Claude, then Codex's key, in the menu's order", () => {
  assert.deepEqual(
    usageCards({ outrunner: "per-user", claude: true, keys: withKeys("openai", "zai", "openrouter", "anthropic") }),
    [
      { kind: "outrunner", metered: true },
      { kind: "key", provider: "openrouter", hint: "…open", reads: true },
      { kind: "key", provider: "anthropic", hint: "…anth", reads: false },
      { kind: "key", provider: "zai", hint: "…zai", reads: false },
      { kind: "claude" },
      { kind: "key", provider: "openai", hint: "…open", reads: false },
    ],
  );
});

test("Outrunner's models on one shared key are shown as unmetered; with none, not at all", () => {
  assert.deepEqual(usageCards({ outrunner: "shared", claude: false, keys: NO_KEYS }), [
    { kind: "outrunner", metered: false },
  ]);
  assert.deepEqual(usageCards({ outrunner: null, claude: false, keys: NO_KEYS }), []);
  assert.deepEqual(usageCards({ outrunner: null, claude: false, keys: withKeys("deepseek") }), [
    { kind: "key", provider: "deepseek", hint: "…deep", reads: true },
  ]);
});
