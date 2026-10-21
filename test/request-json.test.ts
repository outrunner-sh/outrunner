import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { requestJson, UNREACHABLE } from "@/lib/http/request-json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function reply(response: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => response()) as typeof fetch;
}

test("a request that never got there says so, not the browser's 'Load failed'", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Load failed");
  }) as typeof fetch;
  await assert.rejects(requestJson("/api/settings/models", { method: "PUT", body: {} }), { message: UNREACHABLE });
});

test("a refusal shows the route's own sentence", async () => {
  reply(() => new Response(JSON.stringify({ error: "Daytona didn't accept that key." }), { status: 400 }));
  await assert.rejects(requestJson("/x", { fallback: "Couldn't save that." }), { message: "Daytona didn't accept that key." });
});

test("a reply that says nothing usable falls back", async () => {
  reply(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  await assert.rejects(requestJson("/x", { fallback: "Couldn't save that." }), { message: "Couldn't save that." });
  // A 200 without what the caller needs is no success either.
  reply(() => new Response(JSON.stringify({ ok: true })));
  await assert.rejects(
    requestJson<{ keys: string[] }>("/x", { has: (d) => d.keys !== undefined, fallback: "Couldn't save that." }),
    { message: "Couldn't save that." },
  );
});

test("an answer comes back as sent, with its JSON body", async () => {
  let sent: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = init;
    return new Response(JSON.stringify({ keys: ["zai"] }));
  }) as typeof fetch;
  assert.deepEqual(await requestJson("/x", { method: "PUT", body: { a: 1 } }), { keys: ["zai"] });
  assert.equal(sent?.method, "PUT");
  assert.equal(sent?.body, '{"a":1}');
  assert.deepEqual(sent?.headers, { "Content-Type": "application/json" });
});
