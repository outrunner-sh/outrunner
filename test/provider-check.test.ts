import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { checkProviderKey } from "@/lib/providers/check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { url: string; init: RequestInit };
function answer(response: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(response());
  }) as typeof fetch;
  return seen;
}

const KEY = "sk-0123456789abcdef0123456789abcdef";

test("a key the provider takes is accepted, asked the way that provider wants", async () => {
  const seen = answer(() => new Response("{}"));
  assert.deepEqual(await checkProviderKey("deepseek", KEY), { accepted: true });
  assert.equal(seen[0].url, "https://api.deepseek.com/models");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.ok(seen[0].init.signal instanceof AbortSignal, "no timeout");

  await checkProviderKey("anthropic", KEY);
  const headers = seen[1].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], KEY);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers.authorization, undefined, "the key is sent once");
});

test("a key the provider refuses is refused; one with no credit is kept, with a warning", async () => {
  for (const status of [401, 403]) {
    answer(() => new Response("{}", { status }));
    assert.deepEqual(await checkProviderKey("zai", KEY), { accepted: false });
  }
  answer(() => new Response("{}", { status: 402 }));
  const result = await checkProviderKey("moonshot", KEY);
  assert.equal(result.accepted, true);
  assert.match(result.accepted ? (result.warning ?? "") : "", /Moonshot \(Kimi\) accepted the key, but its account has no credit/);
});

test("a provider that can't say is an error, never an answer, and never the body", async () => {
  answer(() => new Response(`{"echo":"${KEY}"}`, { status: 503 }));
  await assert.rejects(checkProviderKey("deepseek", KEY), (error: Error) => /DeepSeek answered 503/.test(error.message) && !error.message.includes(KEY));
  answer(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
  await assert.rejects(checkProviderKey("deepseek", KEY), /timed out/);
});

test("OpenRouter refuses a management key, which can't run a model", async () => {
  answer(() => new Response(JSON.stringify({ data: { is_management_key: true } })));
  assert.deepEqual(await checkProviderKey("openrouter", "sk-or-v1-mgmt-0123456789abcdef"), { accepted: false });
});
