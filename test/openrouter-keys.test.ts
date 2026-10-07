import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createUserKey,
  disableUserKey,
  managementKey,
  NEEV_AI_LIMIT_RESET,
  NEEV_AI_LIMIT_USD,
  NeevAiUnavailableError,
} from "@/lib/openrouter/keys";

const realFetch = globalThis.fetch;
const realManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY;

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
});

test("a user's key is created capped at the monthly allowance", async () => {
  const seen = stubFetch(
    new Response(JSON.stringify({ key: "sk-or-v1-user", data: { hash: "h123", limit: 5 } }), {
      status: 201,
    }),
  );
  const created = await createUserKey("outrunner user u-1");
  assert.deepEqual(created, { key: "sk-or-v1-user", hash: "h123" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/keys");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(
    (seen[0].init.headers as Record<string, string>).authorization,
    "Bearer mgmt-test-key",
  );
  // OpenRouter enforces the cap itself, so it has to be in the create call.
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
    name: "outrunner user u-1",
    limit: NEEV_AI_LIMIT_USD,
    limit_reset: NEEV_AI_LIMIT_RESET,
  });
  assert.equal(NEEV_AI_LIMIT_USD, 5);
  assert.equal(NEEV_AI_LIMIT_RESET, "monthly");
});

test("without a management key Neev AI is unavailable, and nothing is sent", async () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  const seen = stubFetch(new Response("{}", { status: 201 }));
  assert.equal(managementKey(), null);
  await assert.rejects(createUserKey("x"), NeevAiUnavailableError);
  assert.equal(seen.length, 0);
});

test("an OpenRouter error reports its status, never its body", async () => {
  stubFetch(new Response('{"error":"echo of mgmt-test-key"}', { status: 401 }));
  await assert.rejects(createUserKey("x"), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /mgmt-test-key/);
    return true;
  });
});

test("a response without the key is an error, not an empty key", async () => {
  stubFetch(new Response(JSON.stringify({ data: { hash: "h" } }), { status: 201 }));
  await assert.rejects(createUserKey("x"), /no key/);
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
