import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createUserKey,
  disableUserKey,
  setKeyLimit,
  keySource,
  keyUsage,
  managementKey,
  NeevAiUnavailableError,
  openRouterAcceptsKey,
} from "@/lib/openrouter/keys";

const realFetch = globalThis.fetch;
const realManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
const realApiKey = process.env.OPENROUTER_API_KEY;

type Seen = { url: string; init: RequestInit };
function stubFetch(response: Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(response);
  }) as typeof fetch;
  return seen;
}

beforeEach(() => {
  process.env.OPENROUTER_MANAGEMENT_KEY = "mgmt-test-key";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realManagementKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
  else process.env.OPENROUTER_MANAGEMENT_KEY = realManagementKey;
  if (realApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = realApiKey;
});

test("a user's key is created capped at the allowance it is given", async () => {
  const seen = stubFetch(
    new Response(JSON.stringify({ key: "sk-or-v1-user", data: { hash: "h123", limit: 5 } }), {
      status: 201,
    }),
  );
  const created = await createUserKey("outrunner user u-1", 5);
  assert.deepEqual(created, { key: "sk-or-v1-user", hash: "h123" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/keys");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(
    (seen[0].init.headers as Record<string, string>).authorization,
    "Bearer mgmt-test-key",
  );
  // OpenRouter enforces the cap itself, so it has to be in the create call,
  // and with limit_reset null, OpenRouter's "no reset": periods follow billing.
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
    name: "outrunner user u-1",
    limit: 5,
    limit_reset: null,
  });
});

test("without a management key Neev AI is unavailable, and nothing is sent", async () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  const seen = stubFetch(new Response("{}", { status: 201 }));
  assert.equal(managementKey(), null);
  await assert.rejects(createUserKey("x", 5), NeevAiUnavailableError);
  assert.equal(seen.length, 0);
});

test("a refused management key means Outrunner's models are not set up", async () => {
  for (const status of [401, 403]) {
    stubFetch(new Response("{}", { status }));
    await assert.rejects(createUserKey("x", 5), NeevAiUnavailableError);
  }
});

test("an OpenRouter error reports its status, never its body", async () => {
  stubFetch(new Response('{"error":"echo of mgmt-test-key"}', { status: 500 }));
  await assert.rejects(createUserKey("x", 5), (error: Error) => {
    assert.match(error.message, /HTTP 500/);
    assert.doesNotMatch(error.message, /mgmt-test-key/);
    return true;
  });
});

test("a response without the key is an error, not an empty key", async () => {
  stubFetch(new Response(JSON.stringify({ data: { hash: "h" } }), { status: 201 }));
  await assert.rejects(createUserKey("x", 5), /no key/);
});

test("disabling a key patches it by its hash", async () => {
  const seen = stubFetch(new Response("{}", { status: 200 }));
  await disableUserKey("h/1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/keys/h%2F1");
  assert.equal(seen[0].init.method, "PATCH");
  assert.equal(
    (seen[0].init.headers as Record<string, string>).authorization,
    "Bearer mgmt-test-key",
  );
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { disabled: true });
});

test("a failed disable is an error with the status only", async () => {
  stubFetch(new Response('{"error":"echo of mgmt-test-key"}', { status: 404 }));
  await assert.rejects(disableUserKey("h"), (error: Error) => {
    assert.match(error.message, /HTTP 404/);
    assert.doesNotMatch(error.message, /mgmt-test-key/);
    return true;
  });
});

test("a new period's cap is set on the key by its hash, as spend over its life", async () => {
  const seen = stubFetch(new Response("{}", { status: 200 }));
  await setKeyLimit("h/1", 13.5);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/keys/h%2F1");
  assert.equal(seen[0].init.method, "PATCH");
  // limit only: limit_reset stays null, so OpenRouter never resets it itself.
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { limit: 13.5 });
  stubFetch(new Response("{}", { status: 500 }));
  await assert.rejects(setKeyLimit("h", 1), /HTTP 500/);
});

test("a management key means per-user keys, even beside a shared one", () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-shared";
  assert.equal(keySource(), "per-user");
});

test("an API key alone is shared by every session", () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  process.env.OPENROUTER_API_KEY = " sk-or-v1-shared ";
  assert.equal(keySource(), "shared");
});

test("with neither key Outrunner's models are off", () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(keySource(), null);
});

test("a key's usage is read with the management key, by its hash", async () => {
  const seen = stubFetch(
    new Response(JSON.stringify({ data: { hash: "h/1", usage: 1.2345, limit: 5, limit_remaining: 3.7655 } })),
  );
  assert.deepEqual(await keyUsage("h/1"), { usedUsd: 1.2345, limitUsd: 5 });
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/keys/h%2F1");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer mgmt-test-key");
});

test("a key with no limit reads as none, and an answer without usage is an error", async () => {
  stubFetch(new Response(JSON.stringify({ data: { usage: 0, limit: null } })));
  assert.deepEqual(await keyUsage("h"), { usedUsd: 0, limitUsd: null });
  stubFetch(new Response(JSON.stringify({ data: {} })));
  await assert.rejects(keyUsage("h"), /no usage/);
  stubFetch(new Response("nope", { status: 404 }));
  await assert.rejects(keyUsage("h"), /HTTP 404/);
});

test("without a management key there is no usage to read", async () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  await assert.rejects(keyUsage("h"), NeevAiUnavailableError);
});

test("a user's own key is checked with OpenRouter on its own authority", async () => {
  const seen = stubFetch(
    new Response(JSON.stringify({ data: { label: "mine", is_management_key: false, is_provisioning_key: false } })),
  );
  assert.equal(await openRouterAcceptsKey("sk-or-v1-mine"), true);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(new Headers(seen[0].init.headers).get("authorization"), "Bearer sk-or-v1-mine");
});

test("a key OpenRouter refuses, or one that can only make keys, is not taken", async () => {
  stubFetch(new Response(JSON.stringify({ error: { message: "No auth credentials found" } }), { status: 401 }));
  assert.equal(await openRouterAcceptsKey("sk-or-v1-wrong"), false);
  stubFetch(new Response(JSON.stringify({ data: { is_management_key: true } })));
  assert.equal(await openRouterAcceptsKey("sk-or-v1-mgmt"), false);
  stubFetch(new Response(JSON.stringify({ data: { is_provisioning_key: true } })));
  assert.equal(await openRouterAcceptsKey("sk-or-v1-prov"), false);
});

test("an OpenRouter that can't answer is not a refusal", async () => {
  stubFetch(new Response("down", { status: 503 }));
  await assert.rejects(openRouterAcceptsKey("sk-or-v1-mine"), /503/);
});
